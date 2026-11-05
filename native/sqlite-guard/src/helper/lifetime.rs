//! Parent supervision and monotonic deadlines remain runnable while SQLite or standard I/O blocks.

use super::{Failure, wire::MAX_LIFETIME_MS};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
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

/// At most one active and one queued request share the fixed lifetime ceiling.
struct Deadlines {
    lifetime_ms: u64,
    requests: BTreeMap<u32, u64>,
}

impl Deadlines {
    /// Begin idle without losing the absolute process-lifetime deadline.
    fn new(lifetime_ms: u64) -> Self {
        Self {
            lifetime_ms,
            requests: BTreeMap::new(),
        }
    }

    /// Arm before queueing; duplicate IDs and excessive pipelining cannot grow supervision state.
    fn arm(&mut self, id: u32, deadline: u64) -> Result<(), Failure> {
        if self.requests.len() >= 2 || self.requests.contains_key(&id) {
            return Err(Failure::Protocol);
        }
        self.requests.insert(id, deadline.min(self.lifetime_ms));
        Ok(())
    }

    /// The earliest outstanding request can expire even while an earlier operation is still blocked.
    fn earliest(&self) -> u64 {
        self.requests
            .values()
            .copied()
            .min()
            .unwrap_or(self.lifetime_ms)
            .min(self.lifetime_ms)
    }

    /// Completing one response must not erase the next queued request's timer.
    fn complete(&mut self, id: u32) -> Result<(), Failure> {
        self.requests.remove(&id).ok_or(Failure::Protocol)?;
        Ok(())
    }
}

/// Shared supervision caps idle time, queued work, native calls and blocked output.
#[derive(Clone)]
pub(super) struct Watchdog {
    origin: Instant,
    deadlines: Arc<Mutex<Deadlines>>,
}

impl Watchdog {
    /// Start supervision before handshake/source access; only lower lifetime limits are accepted.
    pub(super) fn start(parent_pid: u32, lifetime_ms: u64) -> Result<Self, Failure> {
        if lifetime_ms == 0 || lifetime_ms > MAX_LIFETIME_MS {
            return Err(Failure::Limit);
        }
        let parent = Parent::capture(parent_pid)?;
        let origin = Instant::now();
        let deadlines = Arc::new(Mutex::new(Deadlines::new(lifetime_ms)));
        let observed = deadlines.clone();
        std::thread::Builder::new()
            .name("sqlite-lifetime".into())
            .spawn(move || {
                loop {
                    match parent.alive() {
                        Ok(true) => {}
                        Ok(false) => terminate(Failure::Parent),
                        Err(error) => terminate(error),
                    }
                    let deadline = match observed.lock() {
                        Ok(deadlines) => deadlines.earliest(),
                        Err(_) => terminate(Failure::Guard),
                    };
                    if origin.elapsed().as_millis() >= u128::from(deadline) {
                        terminate(Failure::Deadline);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
            .map_err(|_| Failure::Guard)?;
        Ok(Self { origin, deadlines })
    }

    /// Bound a request from its reception time, including any time spent in the single queued slot.
    pub(super) fn arm(&self, id: u32, received: Instant, timeout_ms: u64) -> Result<(), Failure> {
        let elapsed = received.duration_since(self.origin).as_millis() as u64;
        let deadline = elapsed.checked_add(timeout_ms).ok_or(Failure::Limit)?;
        self.deadlines
            .lock()
            .map_err(|_| Failure::Guard)?
            .arm(id, deadline)?;
        self.check()
    }

    /// Remove only the completed request after checking all currently armed deadlines.
    pub(super) fn complete(&self, id: u32) -> Result<(), Failure> {
        let mut deadlines = self.deadlines.lock().map_err(|_| Failure::Guard)?;
        if self.origin.elapsed().as_millis() >= u128::from(deadlines.earliest()) {
            return Err(Failure::Deadline);
        }
        deadlines.complete(id)
    }

    /// Do not publish or reset a deadline already exceeded between watchdog polling ticks.
    pub(super) fn check(&self) -> Result<(), Failure> {
        let deadline = self
            .deadlines
            .lock()
            .map_err(|_| Failure::Guard)?
            .earliest();
        if self.origin.elapsed().as_millis() >= u128::from(deadline) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_deadline_survives_completion_of_active_work() {
        let mut deadlines = Deadlines::new(30_000);
        deadlines.arm(1, 5000).unwrap();
        deadlines.arm(2, 80).unwrap();
        assert_eq!(deadlines.earliest(), 80);
        deadlines.complete(1).unwrap();
        assert_eq!(deadlines.earliest(), 80);
        deadlines.complete(2).unwrap();
        assert_eq!(deadlines.earliest(), 30_000);
    }

    #[test]
    fn deadlines_remain_bounded_unique_and_within_process_lifetime() {
        let mut deadlines = Deadlines::new(100);
        deadlines.arm(1, 5000).unwrap();
        assert_eq!(deadlines.earliest(), 100);
        assert_eq!(deadlines.arm(1, 50), Err(Failure::Protocol));
        deadlines.arm(2, 80).unwrap();
        assert_eq!(deadlines.arm(3, 70), Err(Failure::Protocol));
        assert_eq!(deadlines.complete(3), Err(Failure::Protocol));
        assert_eq!(deadlines.earliest(), 80);
    }
}
