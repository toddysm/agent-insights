/** Private transport/codec failures use fictional frames and owned stub processes; no native release or private capture is required. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { sqliteDefinitionSchema } from "../src/evidence/source-access.js";
import {
  SqliteFrames,
  sqliteRequestFrame,
  decodeRows,
  sqliteReplySchema,
  MAX_SQLITE_REPLY_BYTES,
  MAX_SQLITE_REQUEST_BYTES,
  SQLITE_OPERATION_MS,
} from "../src/runtime/sqlite-protocol.js";
import {
  SqliteSource,
  nativeSqliteError,
  nativeSqliteAvailability,
} from "../src/runtime/sqlite.js";
import {
  NATIVE_POLICY,
  nativeTarget,
  nativeUnavailable,
} from "../src/runtime/native-helper.js";
import type { DatabaseLease } from "../src/runtime/sources.js";
import { RuntimeError } from "../src/runtime/errors.js";

const definition = sqliteDefinitionSchema.parse({
  userVersions: [1],
  tables: [{ name: "items", columns: ["id"], primaryKey: ["id"] }],
  queries: [{ id: "all", table: "items", columns: ["id"], filters: [] }],
});
const observation = {
  startedAtMs: 1,
  finishedAtMs: 2,
  changed: false,
  snapshotScope: "request",
};

/** Match only fixed runtime error codes, never a payload-bearing native exception. */
function code(expected: string) {
  return (error: unknown) =>
    error instanceof RuntimeError &&
    error.code === expected &&
    !error.message.includes("SECRET");
}

test("native reply framing handles fragmentation/coalescing and rejects oversized/truncated/malformed frames", () => {
  const replies = [
    { kind: "started", id: 1 },
    { kind: "opened", id: 1, userVersion: 1, snapshotScope: "request" },
  ];
  const bytes = Buffer.concat(replies.map(sqliteRequestFrame));
  for (const step of [1, 3, 17, bytes.length]) {
    const decoder = new SqliteFrames(),
      actual: unknown[] = [];
    for (let offset = 0; offset < bytes.length; offset += step)
      decoder.push(bytes.subarray(offset, offset + step), (value) =>
        actual.push(value),
      );
    decoder.finish();
    assert.deepEqual(actual, replies);
  }
  const over = Buffer.alloc(4);
  over.writeUInt32BE(MAX_SQLITE_REPLY_BYTES + 1);
  assert.throws(
    () => new SqliteFrames().push(over, () => assert.fail()),
    code("SQLITE_PROCESS_PROTOCOL"),
  );
  const partial = new SqliteFrames();
  partial.push(Buffer.from([0, 0, 0, 2, 123]), () => assert.fail());
  assert.throws(() => partial.finish(), code("SQLITE_PROCESS_PROTOCOL"));
  for (const malformed of [
    Buffer.from([0, 0, 0, 1, 0xff]),
    sqliteRequestFrame({
      kind: "opened",
      id: 1,
      userVersion: 1,
      snapshotScope: "SECRET",
    }),
  ])
    assert.throws(
      () => new SqliteFrames().push(malformed, () => assert.fail()),
      code("SQLITE_PROCESS_PROTOCOL"),
    );
});

test("request framing enforces its actual exact/one-over encoded limit", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ value: "" }));
  assert.equal(
    sqliteRequestFrame({
      value: "x".repeat(MAX_SQLITE_REQUEST_BYTES - overhead),
    }).length,
    MAX_SQLITE_REQUEST_BYTES + 4,
  );
  assert.throws(
    () =>
      sqliteRequestFrame({
        value: "x".repeat(MAX_SQLITE_REQUEST_BYTES - overhead + 1),
      }),
    code("SQLITE_LIMIT"),
  );
});

test("wire integers and blobs reject noncanonical or unsafe values", () => {
  for (const value of [
    { type: "integer", value: "9223372036854775808" },
    { type: "integer", value: "01" },
    { type: "integer", value: "-0" },
    { type: "integer", value: "SECRET" },
    { type: "integer", value: "1".repeat(1000) },
    { type: "blob", value: "AP8" },
    { type: "blob", value: "AP9=" },
  ]) {
    assert.equal(
      sqliteReplySchema.safeParse({
        kind: "rows",
        id: 1,
        rows: [
          {
            values: { id: value },
            table: "items",
            key: [{ column: "id", type: "integer", value: "1" }],
            fingerprint: "a".repeat(64),
          },
        ],
        bytes: 1,
        observation,
      }).success,
      false,
    );
  }
});

test("result witnesses, row keys, columns and byte accounting are recomputed by the parent", () => {
  const encoded = JSON.stringify([["id", ["integer", "9223372036854775807"]]]);
  const fingerprint = createHash("sha256").update(encoded).digest("hex");
  const key = [{ column: "id", type: "integer", value: "9223372036854775807" }];
  const row = {
    values: { id: { type: "integer", value: "9223372036854775807" } },
    table: "items",
    key,
    fingerprint,
  };
  const bytes =
    Buffer.byteLength(encoded) +
    Buffer.byteLength(JSON.stringify({ table: row.table, key, fingerprint }));
  const raw = { kind: "rows", id: 2, rows: [row], bytes, observation };
  const reply = sqliteReplySchema.parse(raw);
  assert.equal(reply.kind, "rows");
  if (reply.kind !== "rows") assert.fail();
  assert.equal(
    decodeRows(reply, definition, "all", 1, bytes)[0]?.values.id,
    9223372036854775807n,
  );
  for (const changed of [
    { ...raw, bytes: bytes - 1 },
    { ...raw, rows: [{ ...row, fingerprint: "0".repeat(64) }] },
    { ...raw, rows: [{ ...row, table: "other" }] },
    {
      ...raw,
      rows: [{ ...row, key: [{ column: "id", type: "text", value: "1" }] }],
    },
    {
      ...raw,
      rows: [{ ...row, values: { ...row.values, extra: { type: "null" } } }],
    },
    { ...raw, rows: [row, row], bytes: bytes * 2 },
  ]) {
    const invalid = sqliteReplySchema.parse(changed);
    if (invalid.kind !== "rows") assert.fail();
    assert.throws(
      () => decodeRows(invalid, definition, "all", 2, bytes * 2),
      code("SQLITE_PROCESS_PROTOCOL"),
    );
  }
});

test("source, lock, recovery, guard and cleanup categories do not collapse into malformed data", async () => {
  for (const [native, expected] of [
    ["ACCESS_DENIED", "SOURCE_DENIED"],
    ["IO", "SOURCE_IO"],
    ["JOURNAL_PRESENT", "SQLITE_JOURNAL_PRESENT"],
    ["RECOVERY_REQUIRED", "SQLITE_RECOVERY_REQUIRED"],
    ["BUSY", "SQLITE_LOCKED"],
    ["CLEANUP", "SQLITE_CLEANUP_FAILED"],
    ["DATA", "SQLITE_DATA"],
  ] as const)
    assert.equal(nativeSqliteError(native).code, expected);
  const unavailable = await nativeSqliteAvailability(() =>
    Promise.reject(nativeUnavailable()),
  );
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.version, null);
});

/** Synthetic lease records lifetime only; transport tests never authorize a real source path. */
function lease(): DatabaseLease {
  return {
    path: "/SECRET/not-a-source",
    main: { dev: "1", ino: "1", size: "1", mtime: "1", ctime: "1" },
    sidecars: {},
    startedAtMs: 1,
    verify: () => Promise.resolve(false),
    close: () => Promise.resolve(),
  };
}

test("missing helper prevents source admission or subprocess launch", async (t) => {
  const source = lease();
  let verifications = 0;
  source.verify = () => {
    verifications++;
    return Promise.resolve(false);
  };
  const mocked = t.mock.method(childProcess, "spawn", () => {
    throw new Error("Must not spawn");
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const owner = new SqliteSource(source, new AbortController().signal, () =>
    Promise.reject(nativeUnavailable()),
  );
  await assert.rejects(
    owner.initialize(definition),
    code("NATIVE_GUARD_UNAVAILABLE"),
  );
  assert.equal(verifications, 0);
  await owner.stop();
});

test("stopping settles stalled artifact resolution before it returns and prevents late launch", async (t) => {
  const mocked = t.mock.method(childProcess, "spawn", () => {
    throw new Error("Must not spawn");
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  let resolveHelper: ((value: string) => void) | undefined;
  const resolution = new Promise<string>((resolve) => {
    resolveHelper = resolve;
  });
  const owner = new SqliteSource(
    lease(),
    new AbortController().signal,
    () => resolution,
  );
  const initialize = owner.initialize(definition);
  const rejected = assert.rejects(initialize, code("SQLITE_CLOSED"));
  await owner.stop();
  const settled = await Promise.race([
    rejected.then(() => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.ok(resolveHelper);
  resolveHelper("/late-test-helper");
  await rejected;
  assert.equal(settled, true);
});

test("artifact availability rejects at the exact lookup deadline without waiting for resolution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const rejected = assert
    .rejects(
      nativeSqliteAvailability(() => new Promise<string>(() => {})),
      code("READ_TIMEOUT"),
    )
    .then(() => {
      settled = true;
    });
  t.mock.timers.tick(SQLITE_OPERATION_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(settled, true);
});

test("read cancellation and deadline signals settle stalled artifact admission", async () => {
  for (const reason of [
    undefined,
    new RuntimeError("READ_TIMEOUT", "Owned read deadline", 408),
  ]) {
    const controller = new AbortController();
    const owner = new SqliteSource(
      lease(),
      controller.signal,
      () => new Promise<string>(() => {}),
    );
    const rejected = assert.rejects(
      owner.initialize(definition),
      code(reason?.code ?? "READ_CANCELLED"),
    );
    controller.abort(reason);
    await rejected;
    await owner.stop();
  }
});

/** Match a test-only source-free handshake to the actual host, or explicitly skip native-host-specific transport simulation. */
function host(): string | undefined {
  try {
    return nativeTarget();
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    return undefined;
  }
}
const selected = host();

for (const mode of [
  "wrong-handshake",
  "wrong-id",
  "partial",
  "early-exit",
  "wrong-row",
  "cleanup",
  "stderr",
  "extra-reply",
  "close-exit",
  "error-after-rows",
  "duplicate-started",
]) {
  test(
    `native transport rejects ${mode} and confirms owned process exit`,
    { skip: !selected },
    async (t) => {
      const hello = {
        kind: "hello",
        protocolVersion: 1,
        guardVersion: "0.1.0",
        sqliteSourceId: NATIVE_POLICY.sqliteSourceId,
        target: selected,
        qualificationHooks: false,
        maxRequestBytes: 1048576,
        maxReplyBytes: MAX_SQLITE_REPLY_BYTES,
      };
      const children: ReturnType<typeof spawnProcess>[] = [];
      const original = childProcess.spawn;
      const mocked = t.mock.method(childProcess, "spawn", () => {
        const child = original(
          process.execPath,
          [
            fileURLToPath(
              new URL(
                "../../tests/fixtures/native-transport-stub.mjs",
                import.meta.url,
              ),
            ),
            mode,
            JSON.stringify(hello),
          ],
          {
            stdio: "pipe",
            env: {
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
            },
          },
        );
        children.push(child);
        return child;
      });
      syncBuiltinESMExports();
      const owner = new SqliteSource(
        lease(),
        new AbortController().signal,
        () => Promise.resolve("/fixed-test-only-helper"),
      );
      t.after(async () => {
        await owner.stop();
        mocked.mock.restore();
        syncBuiltinESMExports();
      });
      const expected =
        mode === "cleanup"
          ? "SQLITE_CLEANUP_FAILED"
          : mode === "early-exit" || mode === "close-exit"
            ? "SQLITE_PROCESS_FAILED"
            : "SQLITE_PROCESS_PROTOCOL";
      await assert.rejects(
        (async () => {
          await owner.initialize(definition);
          await owner.query("all", {}, 1, 1000);
          await owner.close();
        })(),
        code(expected),
      );
      await owner.stop();
      assert.ok(
        children.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
      );
    },
  );
}
