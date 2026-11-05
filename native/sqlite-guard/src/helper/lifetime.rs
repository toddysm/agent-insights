//! Parent supervision and monotonic deadlines remain runnable while SQLite or standard I/O blocks.

use super::{Failure, wire::MAX_LIFETIME_MS};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

/// One verified direct parent, captured before source admission.
#[cfg(unix)]
struct Parent {
    pid: u32,
}

#[cfg(unix)]
impl Parent {
    /// Bind supervision to the parent's explicit launch identity, rejecting already-orphaned starts.
    fn capture(expected: u32) -> Result<Self, Failure> {
        if expected == 0 || unsafe { libc::getppid() } as u32 != expected {
            return Err(Failure::Parent);
        }
        Ok(Self { pid: expected })
    }

    /// A dead parent reparents its children even while its own PID remains a zombie.
    fn alive(&self) -> Result<bool, Failure> {
        Ok(unsafe { libc::getppid() } as u32 == self.pid)
    }
}

/// The process handle prevents PID reuse from being mistaken for the original live parent.
#[cfg(windows)]
struct Parent {
    handle: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl Parent {
    /// Verify the actual direct parent through the documented process snapshot, then retain a waitable handle.
    fn capture(expected: u32) -> Result<Self, Failure> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{
            Foundation::{ERROR_INVALID_PARAMETER, FILETIME, GetLastError, INVALID_HANDLE_VALUE},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                    TH32CS_SNAPPROCESS,
                },
                Threading::{
                    GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess,
                    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                },
            },
        };
        if expected == 0 {
            return Err(Failure::Parent);
        }
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(Failure::Guard);
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut next = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
        let mut actual = None;
        while next != 0 {
            if entry.th32ProcessID == unsafe { GetCurrentProcessId() } {
                actual = Some(entry.th32ParentProcessID);
                break;
            }
            next = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
        }
        if actual.is_none() {
            return Err(Failure::Guard);
        }
        if actual != Some(expected) {
            return Err(Failure::Parent);
        }
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                expected,
            )
        };
        if handle.is_null() {
            return Err(if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                Failure::Parent
            } else {
                Failure::Guard
            });
        }
        let parent = Self {
            handle: unsafe { OwnedHandle::from_raw_handle(handle) },
        };
        let mut parent_created: FILETIME = unsafe { std::mem::zeroed() };
        let mut child_created: FILETIME = unsafe { std::mem::zeroed() };
        let mut ended: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        if unsafe {
            GetProcessTimes(
                parent.handle.as_raw_handle(),
                &mut parent_created,
                &mut ended,
                &mut kernel,
                &mut user,
            )
        } == 0
            || unsafe {
                GetProcessTimes(
                    GetCurrentProcess(),
                    &mut child_created,
                    &mut ended,
                    &mut kernel,
                    &mut user,
                )
            } == 0
        {
            return Err(Failure::Guard);
        }
        if filetime_value(parent_created) > filetime_value(child_created) {
            return Err(Failure::Parent);
        }
        if !parent.alive()? {
            return Err(Failure::Parent);
        }
        Ok(parent)
    }

    /// Query the retained process object, not a potentially recycled PID.
    fn alive(&self) -> Result<bool, Failure> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::WaitForSingleObject,
        };
        match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => Ok(false),
            WAIT_TIMEOUT => Ok(true),
            _ => Err(Failure::Guard),
        }
    }
}

/// Reject a parent PID recycled into a process created after this helper.
#[cfg(windows)]
fn filetime_value(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

/// A process-wide watchdog caps idle time, partial frames, native work and blocked output.
pub(super) struct Watchdog {
    origin: Instant,
    deadline: Arc<AtomicU64>,
    lifetime_ms: u64,
}

impl Watchdog {
    /// Start supervision before handshake/source access; only lower lifetime limits are accepted.
    pub(super) fn start(parent_pid: u32, lifetime_ms: u64) -> Result<Self, Failure> {
        if lifetime_ms == 0 || lifetime_ms > MAX_LIFETIME_MS {
            return Err(Failure::Limit);
        }
        let parent = Parent::capture(parent_pid)?;
        let origin = Instant::now();
        let deadline = Arc::new(AtomicU64::new(lifetime_ms));
        let observed = deadline.clone();
        std::thread::Builder::new()
            .name("sqlite-lifetime".into())
            .spawn(move || {
                loop {
                    match parent.alive() {
                        Ok(true) => {}
                        Ok(false) => terminate(Failure::Parent),
                        Err(error) => terminate(error),
                    }
                    if origin.elapsed().as_millis() >= u128::from(observed.load(Ordering::Acquire))
                    {
                        terminate(Failure::Deadline);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
            .map_err(|_| Failure::Guard)?;
        Ok(Self {
            origin,
            deadline,
            lifetime_ms,
        })
    }

    /// Bound a request from its reception time, including any time spent in the single queued slot.
    pub(super) fn operation(&self, received: Instant, timeout_ms: u64) -> Result<(), Failure> {
        let elapsed = received.duration_since(self.origin).as_millis() as u64;
        let deadline = elapsed
            .checked_add(timeout_ms)
            .ok_or(Failure::Limit)?
            .min(self.lifetime_ms);
        self.deadline.store(deadline, Ordering::Release);
        if self.origin.elapsed().as_millis() >= u128::from(deadline) {
            return Err(Failure::Deadline);
        }
        Ok(())
    }

    /// Finishing a request does not extend the fixed process lifetime.
    pub(super) fn idle(&self) {
        self.deadline.store(self.lifetime_ms, Ordering::Release);
    }

    /// Do not publish or reset a deadline already exceeded between watchdog polling ticks.
    pub(super) fn check(&self) -> Result<(), Failure> {
        if self.origin.elapsed().as_millis() >= u128::from(self.deadline.load(Ordering::Acquire)) {
            Err(Failure::Deadline)
        } else {
            Ok(())
        }
    }
}

/// Exit without any I/O that could itself block; the fixed exit code identifies the failure.
/// The OS releases this process's handles and locks without invoking producer recovery.
pub(super) fn terminate(failure: Failure) -> ! {
    std::process::exit(failure.exit_code())
}
