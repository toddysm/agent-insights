/** Fault-only transport process selected by test-owned spawn mocks; never used by application startup. */
const mode = process.argv[2];
const hello = JSON.parse(process.argv[3]);
/** Emit one small fictional frame with controlled optional exit. */
function send(value, end) {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([prefix, payload]), () => {
    if (end !== undefined) process.exit(end);
  });
}
if (mode === "wrong-handshake") hello.qualificationHooks = true;
send(hello);
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length < 4) return;
  const size = buffer.readUInt32BE();
  if (buffer.length < size + 4) return;
  const request = JSON.parse(buffer.subarray(4, size + 4).toString("utf8"));
  buffer = buffer.subarray(size + 4);
  if (mode === "early-exit") process.exit(0);
  if (mode === "stderr") {
    process.stderr.write("x".repeat(9000));
    return;
  }
  send({ kind: "started", id: request.id });
  if (mode === "duplicate-started") send({ kind: "started", id: request.id });
  if (mode === "partial") {
    process.stdout.write(Buffer.from([0, 0, 0, 20, 123]), () =>
      process.exit(0),
    );
    return;
  }
  if (mode === "cleanup") {
    send({ kind: "error", id: request.id, code: "CLEANUP" }, 72);
    return;
  }
  if (request.kind === "open") {
    send({
      kind: "opened",
      id: mode === "wrong-id" ? request.id + 1 : request.id,
      userVersion: 1,
      snapshotScope: "request",
    });
    if (mode === "extra-reply")
      send({
        kind: "opened",
        id: request.id,
        userVersion: 1,
        snapshotScope: "request",
      });
  } else if (request.kind === "query") {
    send({
      kind: "rows",
      id: request.id,
      rows: [],
      bytes: mode === "wrong-row" ? 1 : 0,
      observation: {
        startedAtMs: 1,
        finishedAtMs: 2,
        changed: false,
        snapshotScope: "request",
      },
    });
    if (mode === "error-after-rows")
      send({ kind: "error", id: request.id, code: "IO" });
  } else if (request.kind === "close") {
    send(
      {
        kind: "closed",
        id: request.id,
        observation: {
          startedAtMs: 1,
          finishedAtMs: 2,
          changed: false,
          snapshotScope: "request",
        },
      },
      mode === "close-exit" ? 70 : 0,
    );
  }
});
