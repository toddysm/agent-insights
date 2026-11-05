//! Execute the real helper and its independent producer/client fixtures; no private sources or models.

use std::process::Command;

/// Candidate qualification may select an explicit test-owned packaged binary; serving code has no path override.
#[cfg(not(feature = "qualification-hooks"))]
fn helper_executable() -> std::ffi::OsString {
    std::env::var_os("AGENT_INSIGHTS_TEST_HELPER")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_agent-insights-sqlite-helper").into())
}

/// Read only the small control replies used by the parent-loss test.
#[cfg(not(feature = "qualification-hooks"))]
fn control_reply(input: &mut impl std::io::Read) -> serde_json::Value {
    let mut prefix = [0; 4];
    input.read_exact(&mut prefix).unwrap();
    let size = u32::from_be_bytes(prefix) as usize;
    assert!(size <= 4096);
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn self_check_is_source_free_and_identifies_qualification_builds() {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-insights-sqlite-helper"))
        .arg("--check")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(output.stdout.len() > 4);
    let size = u32::from_be_bytes(output.stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(size, output.stdout.len() - 4);
    let hello: serde_json::Value = serde_json::from_slice(&output.stdout[4..]).unwrap();
    assert_eq!(hello["kind"], "hello");
    assert_eq!(hello["protocolVersion"], 1);
    assert_eq!(
        hello["sqliteSourceId"],
        agent_insights_sqlite_guard::SQLITE_SOURCE_ID
    );
    assert_eq!(
        hello["qualificationHooks"],
        cfg!(feature = "qualification-hooks")
    );
}

#[cfg(not(feature = "qualification-hooks"))]
#[test]
fn production_protocol_and_process_lifetime() {
    let status = Command::new("node")
        .arg("--test")
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol.mjs"))
        .env(
            "AGENT_INSIGHTS_TEST_HELPER",
            env!("CARGO_BIN_EXE_agent-insights-sqlite-helper"),
        )
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .status()
        .unwrap();
    assert!(
        status.success(),
        "Native protocol subprocess qualification failed"
    );
}

#[cfg(not(feature = "qualification-hooks"))]
#[test]
fn parent_loss_exits_while_native_work_and_the_control_channel_remain_open() {
    use std::io::{Read, Write};
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("source.db");
    let (reader, mut control) = std::io::pipe().unwrap();
    let mut parent = Command::new("node")
        .arg("--disable-warning=ExperimentalWarning")
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/parent.mjs"))
        .arg(helper_executable())
        .arg(&file)
        .stdin(Stdio::from(reader))
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .spawn()
        .unwrap();
    let mut output = parent.stdout.take().unwrap();
    assert_eq!(control_reply(&mut output)["kind"], "hello");
    let open = serde_json::to_vec(&serde_json::json!({
        "kind":"open", "id":1, "protocolVersion":1, "path":file,
        "timeoutMs":2500,
        "definition": {"userVersions":[1], "tables":[{"name":"items","columns":["id","value"],"primaryKey":["id"]}],
          "queries":[{"id":"all","table":"items","columns":["id","value"],"filters":[]}]}
    })).unwrap();
    control
        .write_all(&(open.len() as u32).to_be_bytes())
        .unwrap();
    control.write_all(&open).unwrap();
    assert_eq!(control_reply(&mut output)["kind"], "started");
    std::thread::sleep(Duration::from_millis(30));
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut tail = Vec::new();
        let result = output.take(4097).read_to_end(&mut tail);
        send.send((result, tail)).unwrap();
    });
    let started = Instant::now();
    parent.kill().unwrap();
    parent.wait().unwrap();
    let observed = receive.recv_timeout(Duration::from_millis(900));
    if observed.is_err() {
        // On a failed parent-monitor regression, EOF independently stops the owned helper before fixture teardown.
        drop(control);
        assert!(
            receive.recv_timeout(Duration::from_secs(5)).is_ok(),
            "Owned helper did not release its output"
        );
        panic!("Helper survived its parent while stdin stayed open");
    }
    let (read, tail) = observed.unwrap();
    read.unwrap();
    assert!(tail.len() <= 4096);
    assert!(started.elapsed() < Duration::from_millis(900));
    // The control writer is deliberately still live here: EOF cannot explain the helper's exit.
    drop(control);
}

#[cfg(feature = "qualification-hooks")]
#[test]
fn qualification_build_cannot_serve_sources() {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-insights-sqlite-helper"))
        .args([
            "--parent-pid",
            &std::process::id().to_string(),
            "--lifetime-ms",
            "1000",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "Native database helper: GUARD_UNAVAILABLE.\n"
    );
}
