//! Private, bounded native helper protocol. It does not expose a server or register application readers.
//! Only the trusted parent supplies authorized paths and application-owned query declarations.

mod lifetime;
mod query;
pub(crate) mod wire;

use crate::{GuardError, SQLITE_SOURCE_ID, inspect_engine, inspect_native_abi};
use lifetime::{Watchdog, terminate};
use query::Session;
use std::ffi::OsString;
use std::io::Write;
use std::sync::mpsc::{self, TrySendError};
use std::time::Instant;
use wire::{MAX_LIFETIME_MS, Reply, Request, VERSION, read_frame, write_frame};

/// Fixed failure vocabulary; no source payload, query text or native exception is included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Protocol,
    Channel,
    Parent,
    Deadline,
    Cancelled,
    Guard,
    Policy,
    Engine,
    Cleanup,
    Access,
    Missing,
    Changed,
    Io,
    Busy,
    Recovery,
    Journal,
    Schema,
    Query,
    Bindings,
    Limit,
    Data,
    Clock,
}

impl Failure {
    /// Stable wire/diagnostic codes are independent of SQLite's source-dependent messages.
    fn code(self) -> &'static str {
        match self {
            Self::Protocol => "PROTOCOL",
            Self::Channel => "CHANNEL_LOST",
            Self::Parent => "PARENT_LOST",
            Self::Deadline => "DEADLINE",
            Self::Cancelled => "CANCELLED",
            Self::Guard => "GUARD_UNAVAILABLE",
            Self::Policy => "POLICY_VIOLATION",
            Self::Engine => "ENGINE_MISMATCH",
            Self::Cleanup => "CLEANUP",
            Self::Access => "ACCESS_DENIED",
            Self::Missing => "SOURCE_UNAVAILABLE",
            Self::Changed => "SOURCE_CHANGED",
            Self::Io => "IO",
            Self::Busy => "BUSY",
            Self::Recovery => "RECOVERY_REQUIRED",
            Self::Journal => "JOURNAL_PRESENT",
            Self::Schema => "SCHEMA",
            Self::Query => "QUERY",
            Self::Bindings => "BINDINGS",
            Self::Limit => "LIMIT",
            Self::Data => "DATA",
            Self::Clock => "CLOCK",
        }
    }

    /// Exit codes remain observable even when a blocked/broken output channel prevents an error frame.
    fn exit_code(self) -> i32 {
        match self {
            Self::Protocol => 64,
            Self::Guard | Self::Engine | Self::Policy => 65,
            Self::Cancelled => 66,
            Self::Deadline => 67,
            Self::Parent => 68,
            Self::Channel => 69,
            Self::Limit => 71,
            Self::Cleanup => 72,
            _ => 70,
        }
    }
}

impl From<GuardError> for Failure {
    /// Keep source access, recovery, corruption and guard failures distinct across the process boundary.
    fn from(error: GuardError) -> Self {
        match error {
            GuardError::EngineMismatch => Self::Engine,
            GuardError::GuardUnavailable | GuardError::InUse => Self::Guard,
            GuardError::SourceUnavailable => Self::Missing,
            GuardError::Io => Self::Io,
            GuardError::AccessDenied => Self::Access,
            GuardError::SourceChanged => Self::Changed,
            GuardError::Limit => Self::Limit,
            GuardError::RecoveryRequired => Self::Recovery,
            GuardError::JournalPresent => Self::Journal,
            GuardError::Schema => Self::Schema,
            GuardError::PolicyViolation => Self::Policy,
            GuardError::Busy => Self::Busy,
            GuardError::Data => Self::Data,
            GuardError::InvalidInput => Self::Query,
            GuardError::Cleanup => Self::Cleanup,
        }
    }
}

/// Launch controls contain no source paths; source authorization remains in the parent's first framed request.
struct Options {
    parent_pid: u32,
    lifetime_ms: u64,
    check: bool,
}

impl Options {
    /// Accept only a direct-parent identity and a bounded lifetime, or a source-free self-check.
    fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, Failure> {
        let args = args
            .into_iter()
            .map(|arg| arg.into_string().map_err(|_| Failure::Protocol))
            .collect::<Result<Vec<_>, _>>()?;
        if args == ["--check"] {
            return Ok(Self {
                parent_pid: 0,
                lifetime_ms: MAX_LIFETIME_MS,
                check: true,
            });
        }
        if args.len() != 4 || args[0] != "--parent-pid" || args[2] != "--lifetime-ms" {
            return Err(Failure::Protocol);
        }
        let parent_pid = args[1].parse().map_err(|_| Failure::Protocol)?;
        let lifetime_ms = args[3].parse().map_err(|_| Failure::Protocol)?;
        if parent_pid == 0 || lifetime_ms == 0 || lifetime_ms > MAX_LIFETIME_MS {
            return Err(Failure::Limit);
        }
        Ok(Self {
            parent_pid,
            lifetime_ms,
            check: false,
        })
    }
}

/// Check the pinned engine/seams without opening session sources.
///
/// # Safety
/// This process owns SQLite exclusively and no connection or other VFS consumer exists.
unsafe fn hello() -> Result<Reply, Failure> {
    inspect_engine()?;
    unsafe { inspect_native_abi() }?;
    Ok(Reply::Hello {
        protocol_version: VERSION,
        guard_version: env!("CARGO_PKG_VERSION"),
        sqlite_source_id: SQLITE_SOURCE_ID,
        target: env!("AGENT_INSIGHTS_NATIVE_TARGET"),
        qualification_hooks: cfg!(feature = "qualification-hooks"),
        max_request_bytes: wire::MAX_REQUEST_BYTES,
        max_reply_bytes: wire::MAX_REPLY_BYTES,
    })
}

/// Drain bounded frames independently of SQLite; cancel, EOF and malformed messages terminate actual work.
fn input_thread(sender: mpsc::SyncSender<Request>, watchdog: Watchdog) {
    let mut input = std::io::stdin().lock();
    let mut last_id = 0u32;
    loop {
        let frame = read_frame(&mut input).unwrap_or_else(|error| terminate(error));
        let received = Instant::now();
        let request: Request =
            serde_json::from_slice(&frame).unwrap_or_else(|_| terminate(Failure::Protocol));
        if request.id() != last_id + 1 {
            terminate(Failure::Protocol);
        }
        last_id = request.id();
        if last_id > wire::MAX_QUERIES as u32 + 3 {
            terminate(Failure::Limit);
        }
        if matches!(request, Request::Cancel { .. }) {
            terminate(Failure::Cancelled);
        }
        let timeout = request.timeout().unwrap_or_else(|error| terminate(error));
        watchdog
            .arm(request.id(), received, timeout)
            .unwrap_or_else(|error| terminate(error));
        if let Err(error) = sender.try_send(request) {
            match error {
                TrySendError::Full(_) => terminate(Failure::Protocol),
                TrySendError::Disconnected(_) => terminate(Failure::Channel),
            }
        }
    }
}

/// Run the single-source state machine; every error is terminal and successful close follows actual cleanup.
///
/// # Safety
/// The caller satisfies the process-exclusive engine contract for every guarded connection.
unsafe fn serve(options: Options, output: &mut impl Write) -> Result<(), Failure> {
    let watchdog = Watchdog::start(options.parent_pid, options.lifetime_ms)?;
    if cfg!(feature = "qualification-hooks") {
        return Err(Failure::Guard);
    }
    write_frame(output, &unsafe { hello() }?)?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let input_watchdog = watchdog.clone();
    std::thread::Builder::new()
        .name("sqlite-input".into())
        .spawn(move || input_thread(sender, input_watchdog))
        .map_err(|_| Failure::Guard)?;
    let mut session: Option<Session> = None;
    loop {
        let request = receiver.recv().map_err(|_| Failure::Channel)?;
        let id = request.id();
        watchdog.check()?;
        write_frame(output, &Reply::Started { id })?;
        let closing = matches!(request, Request::Close { .. });
        let result = match request {
            Request::Open {
                id,
                protocol_version,
                path,
                definition,
                ..
            } if session.is_none() && id == 1 => {
                if protocol_version != VERSION {
                    Err(Failure::Protocol)
                } else {
                    unsafe { Session::open(&path, definition) }.map(|(opened, user_version)| {
                        let reply = Reply::Opened {
                            id,
                            user_version,
                            snapshot_scope: opened.scope(),
                        };
                        session = Some(opened);
                        reply
                    })
                }
            }
            Request::Query {
                query_id,
                bindings,
                max_rows,
                max_bytes,
                ..
            } => {
                if let Some(session) = session.as_mut() {
                    session.query(id, &query_id, &bindings, max_rows, max_bytes)
                } else {
                    Err(Failure::Protocol)
                }
            }
            Request::Close { .. } => match session.take() {
                Some(session) => session.close(id),
                None => Err(Failure::Protocol),
            },
            _ => Err(Failure::Protocol),
        };
        watchdog.check()?;
        match result {
            Ok(reply) => write_frame(output, &reply)?,
            Err(error) => {
                let error = if let Some(session) = session.take() {
                    match session.abort() {
                        Ok(_) => error,
                        Err(cleanup) => cleanup,
                    }
                } else {
                    error
                };
                write_frame(
                    output,
                    &Reply::Error {
                        id,
                        code: error.code(),
                    },
                )?;
                return Err(error);
            }
        }
        watchdog.check()?;
        if closing {
            return Ok(());
        }
        watchdog.complete(id)?;
    }
}

/// Own this process's standard channels and SQLite engine until successful close or controlled termination.
///
/// # Safety
/// The caller must exclusively own the linked SQLite engine and the process's standard
/// channels. Watchdog/input threads may terminate the entire process to bound native work.
/// This entry point is for the standalone helper executable, not an embedded application thread.
///
/// Returns a fixed exit code. Diagnostics contain codes only, never native errors, arguments or payloads.
pub unsafe fn run(args: impl IntoIterator<Item = OsString>) -> i32 {
    std::panic::set_hook(Box::new(|_| terminate(Failure::Guard)));
    let result = (|| {
        let options = Options::parse(args)?;
        let mut output = std::io::stdout().lock();
        if options.check {
            std::thread::Builder::new()
                .name("sqlite-self-check".into())
                .spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(wire::MAX_OPERATION_MS));
                    terminate(Failure::Deadline);
                })
                .map_err(|_| Failure::Guard)?;
            write_frame(&mut output, &unsafe { hello() }?)
        } else {
            unsafe { serve(options, &mut output) }
        }
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            // Exit status remains authoritative if the diagnostic reader has already closed.
            let _ = writeln!(
                std::io::stderr().lock(),
                "Native database helper: {}.",
                error.code()
            );
            error.exit_code()
        }
    }
}
