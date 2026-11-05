/** Qualify the actual framed helper with synthetic databases; producers and readers are different processes. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

const executable = process.env.AGENT_INSIGHTS_TEST_HELPER;
assert.ok(executable);
const MAX_REPLY = 24 * 1024 * 1024;
const MAX_REQUEST = 1024 * 1024;
const MAX_RESULT = 8 * 1024 * 1024;
const definition = {
  userVersions: [1],
  tables: [
    {
      name: "items",
      columns: ["id", "value", "real", "blob", "empty", "document"],
      primaryKey: ["id"],
    },
  ],
  queries: [
    {
      id: "all",
      table: "items",
      columns: ["id", "value", "real", "blob", "empty"],
      filters: [],
    },
    {
      id: "one",
      table: "items",
      columns: ["id", "value"],
      filters: [{ column: "id", parameter: "id" }],
    },
    {
      id: "json",
      table: "items",
      columns: ["id"],
      filters: [{ column: "document", parameter: "n", jsonPath: ["n"] }],
    },
    { id: "ids", table: "items", columns: ["id"], filters: [] },
    {
      id: "by_blob",
      table: "items",
      columns: ["id", "blob"],
      filters: [{ column: "blob", parameter: "blob" }],
    },
  ],
};

/** Bound test waits and clear their timers on either success or failure. */
async function bounded(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fixture deadline exceeded")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A separately owned synthetic producer; only this fixture creates or changes its source files. */
function fixture(
  t,
  { wal = true, count = 2, value = "fixture-\u{1f980}" } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "insights-protocol-"));
  const file = realpathSync(root) + path.sep + "source.db";
  const database = new DatabaseSync(file);
  database.exec(`PRAGMA journal_mode=${wal ? "WAL" : "DELETE"}; PRAGMA user_version=1;
    CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT, real REAL, blob BLOB, empty TEXT, document TEXT)`);
  const insert = database.prepare("INSERT INTO items VALUES(?,?,?,?,?,?)");
  database.exec("BEGIN");
  for (let i = 0; i < count; i++)
    insert.run(
      9007199254740993n + BigInt(i),
      value,
      1e-7,
      Buffer.from([0, 255]),
      null,
      '{"n":7}',
    );
  database.exec("COMMIT");
  t.after(() => {
    if (database.isOpen) database.close();
    rmSync(root, { recursive: true });
  });
  return { database, file, root };
}

/** Spawn only the fixed test helper, with no inherited provider/debugger/loader environment. */
function childOptions(lifetime = 30_000) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    args: [
      "--parent-pid",
      String(process.pid),
      "--lifetime-ms",
      String(lifetime),
    ],
    env,
  };
}

/** Minimal bounded test client; successful rows are not treated as a completed read until close and exit succeed. */
class Helper {
  /** Start an owned helper and register a kill/reap fallback for a failing fixture. */
  constructor(t, lifetime = 30_000) {
    const { args, env } = childOptions(lifetime);
    this.child = spawn(executable, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.id = 0;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.stderr = "";
    this.inputError = null;
    this.child.stdin.on("error", (error) => {
      this.inputError = error;
    });
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code, signal) => {
        this.ended = true;
        for (const waiter of this.waiters.splice(0))
          waiter.reject(new Error("Helper exited before a complete reply"));
        resolve({ code, signal });
      });
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      assert.ok(this.stderr.length <= 4096);
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      assert.ok(this.buffer.length <= MAX_REPLY + 65540);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE();
        assert.ok(length > 0 && length <= MAX_REPLY);
        if (this.buffer.length < length + 4) {
          if (length > 65536 && this.pauseLargeReply) {
            const paused = this.pauseLargeReply;
            this.pauseLargeReply = null;
            this.child.stdout.pause();
            paused();
          }
          break;
        }
        const message = JSON.parse(
          this.buffer.subarray(4, length + 4).toString("utf8"),
        );
        assert.ok(
          ["hello", "started", "opened", "rows", "closed", "error"].includes(
            message.kind,
          ),
        );
        this.buffer = this.buffer.subarray(length + 4);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else {
          this.queue.push(message);
          assert.ok(this.queue.length <= 3);
        }
      }
    });
    t.after(async () => {
      if (!this.ended) this.child.kill("SIGKILL");
      await bounded(this.exited);
    });
  }

  /** Receive a whole bounded frame; truncated output is never converted into empty success. */
  next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.reject(new Error("Helper already exited"));
    return bounded(
      new Promise((resolve, reject) => this.waiters.push({ resolve, reject })),
    );
  }

  /** Send a strict numbered request; callers may supply padded raw frames for boundary tests. */
  send(body, raw) {
    assert.equal(this.inputError, null);
    const id = ++this.id;
    const payload = raw ?? Buffer.from(JSON.stringify({ ...body, id }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    this.child.stdin.write(Buffer.concat([header, payload]));
    return id;
  }

  /** Validate startup compatibility independently of any source read. */
  async hello() {
    const hello = await this.next();
    assert.equal(hello.kind, "hello");
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.guardVersion, "0.1.0");
    assert.equal(hello.qualificationHooks, false);
    assert.match(hello.sqliteSourceId, /^2026-10-16 .*555e07/);
    assert.equal(hello.maxRequestBytes, MAX_REQUEST);
    assert.equal(hello.maxReplyBytes, MAX_REPLY);
  }

  /** Correlate both started and terminal replies, rejecting unexpected/stale IDs. */
  async request(body) {
    const id = this.send(body);
    assert.deepEqual(await this.next(), { kind: "started", id });
    const reply = await this.next();
    assert.equal(reply.id, id);
    return reply;
  }

  /** Admit the code-owned fixture declaration and exact authorized fixture path. */
  open(file, schema = definition) {
    return this.request({
      kind: "open",
      protocolVersion: 1,
      path: file,
      definition: schema,
      timeoutMs: 5000,
    });
  }

  /** Request a declared projection with explicit row, byte and time limits. */
  query(queryId = "all", bindings = {}, limits = {}) {
    return this.request({
      kind: "query",
      queryId,
      bindings,
      maxRows: 10_000,
      maxBytes: MAX_RESULT,
      timeoutMs: 5000,
      ...limits,
    });
  }

  /** Keep stdin open until the successful close is flushed and the process actually exits. */
  async close() {
    const reply = await this.request({ kind: "close" });
    assert.equal(reply.kind, "closed");
    assert.deepEqual(await bounded(this.exited), { code: 0, signal: null });
    assert.equal(this.stderr, "");
    return reply;
  }
}

/** Reconstruct the prior projection witness from the tagged original values, not JSON-coerced integers. */
function witness(columns, values) {
  return JSON.stringify(
    columns.map((name) => {
      const cell = values[name];
      return [
        name,
        cell.type === "integer"
          ? ["integer", cell.value]
          : cell.type === "blob"
            ? ["blob", cell.value]
            : cell.type === "real"
              ? ["number", cell.value]
              : cell.type === "text"
                ? ["string", cell.value]
                : ["null", null],
      ];
    }),
  );
}

test("native projections preserve typed cells, original keys, hashes and per-mode snapshots", async (t) => {
  for (const wal of [false, true]) {
    const source = fixture(t, { wal });
    const helper = new Helper(t);
    await helper.hello();
    const opened = await helper.open(source.file);
    assert.equal(opened.kind, "opened");
    assert.equal(opened.userVersion, 1);
    assert.equal(opened.snapshotScope, wal ? "connection" : "request");
    const before = readFileSync(source.file);
    const result = await helper.query();
    assert.equal(result.kind, "rows");
    assert.equal(result.rows.length, 2);
    const first = result.rows[0];
    assert.deepEqual(first.values.id, {
      type: "integer",
      value: "9007199254740993",
    });
    assert.deepEqual(first.values.blob, { type: "blob", value: "AP8=" });
    assert.deepEqual(first.values.empty, { type: "null" });
    assert.deepEqual(first.key, [
      { column: "id", type: "integer", value: "9007199254740993" },
    ]);
    let bytes = 0;
    for (const row of result.rows) {
      const encoded = witness(definition.queries[0].columns, row.values);
      assert.equal(
        row.fingerprint,
        createHash("sha256").update(encoded).digest("hex"),
      );
      bytes +=
        Buffer.byteLength(encoded) +
        Buffer.byteLength(
          JSON.stringify({
            table: row.table,
            key: row.key,
            fingerprint: row.fingerprint,
          }),
        );
    }
    assert.equal(result.bytes, bytes);
    assert.deepEqual(readFileSync(source.file), before);
    source.database.exec("UPDATE items SET value='updated'");
    const afterWriter = readFileSync(source.file);
    const selected = await helper.query("one", {
      id: { type: "integer", value: "9007199254740993" },
    });
    assert.equal(
      selected.rows[0].values.value.value,
      wal ? "fixture-\u{1f980}" : "updated",
    );
    const blob = await helper.query("by_blob", {
      blob: { type: "blob", value: "AP8=" },
    });
    assert.equal(blob.rows.length, 2);
    const literal = await helper.query("one", {
      id: {
        type: "text",
        value: "'; ATTACH DATABASE 'unapproved.db' AS other; --",
      },
    });
    assert.deepEqual(literal.rows, []);
    const json = await helper.query("json", {
      n: { type: "integer", value: "7" },
    });
    assert.equal(json.rows.length, 2);
    const closed = await helper.close();
    assert.equal(closed.observation.changed, true);
    assert.ok(
      closed.observation.finishedAtMs >= closed.observation.startedAtMs,
    );
    assert.deepEqual(readFileSync(source.file), afterWriter);
  }
});

test("row/encoded-byte limits are exact, with no partial result on one-over", async (t) => {
  const source = fixture(t);
  const helper = new Helper(t);
  await helper.hello();
  await helper.open(source.file);
  const first = await helper.query("one", {
    id: { type: "integer", value: "9007199254740993" },
  });
  const exact = await helper.query(
    "one",
    { id: { type: "integer", value: "9007199254740993" } },
    { maxRows: 1, maxBytes: first.bytes },
  );
  assert.equal(exact.kind, "rows");
  assert.equal(exact.bytes, first.bytes);
  const over = await helper.query(
    "one",
    { id: { type: "integer", value: "9007199254740993" } },
    { maxBytes: first.bytes - 1 },
  );
  assert.equal(over.kind, "error");
  assert.equal(over.code, "LIMIT");
  assert.equal((await bounded(helper.exited)).code, 71);
  const second = new Helper(t);
  await second.hello();
  await second.open(source.file);
  assert.equal((await second.query("all", {}, { maxRows: 1 })).code, "LIMIT");
  assert.equal((await bounded(second.exited)).code, 71);
});

test("undeclared operations, wrong schemas and invalid bindings fail explicitly", async (t) => {
  const source = fixture(t);
  for (const [body, code] of [
    [
      {
        kind: "query",
        queryId: "unknown",
        bindings: {},
        maxRows: 1,
        maxBytes: 1000,
        timeoutMs: 1000,
      },
      "QUERY",
    ],
    [
      {
        kind: "query",
        queryId: "one",
        bindings: { id: { type: "integer", value: "9223372036854775808" } },
        maxRows: 1,
        maxBytes: 1000,
        timeoutMs: 1000,
      },
      "BINDINGS",
    ],
    [
      {
        kind: "query",
        queryId: "one",
        bindings: {},
        maxRows: 1,
        maxBytes: 1000,
        timeoutMs: 1000,
      },
      "BINDINGS",
    ],
  ]) {
    const helper = new Helper(t);
    await helper.hello();
    await helper.open(source.file);
    const result = await helper.request(body);
    assert.equal(result.kind, "error");
    assert.equal(result.code, code);
    assert.notEqual((await bounded(helper.exited)).code, 0);
  }
  const helper = new Helper(t);
  await helper.hello();
  assert.equal(
    (await helper.open(source.file, { ...definition, userVersions: [999] }))
      .code,
    "SCHEMA",
  );
  await bounded(helper.exited);
});

test("framing rejects malformed, oversized, truncated and out-of-order input without payload diagnostics", async (t) => {
  for (const mode of [
    "malformed",
    "oversized",
    "truncated",
    "duplicate",
    "extra-field",
  ]) {
    const helper = new Helper(t);
    await helper.hello();
    if (mode === "oversized") {
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(MAX_REQUEST + 1);
      helper.child.stdin.write(prefix);
    } else if (mode === "truncated") {
      helper.child.stdin.end(Buffer.from([0, 0, 0, 4, 123]));
    } else {
      helper.send(
        {},
        Buffer.from(
          mode === "malformed"
            ? '{"SECRET_CANARY":'
            : JSON.stringify({
                kind: "cancel",
                id: mode === "duplicate" ? 2 : 1,
                SECRET_CANARY: true,
              }),
        ),
      );
    }
    assert.notEqual((await bounded(helper.exited)).code, 0);
    assert.ok(!helper.stderr.includes("SECRET_CANARY"));
  }
});

test("cancellation, EOF and deadlines terminate an actual blocked native query and release locks", async (t) => {
  for (const action of ["cancel", "eof", "deadline"]) {
    const source = fixture(t, { wal: false });
    const helper = new Helper(t);
    await helper.hello();
    await helper.open(source.file);
    source.database.exec("BEGIN EXCLUSIVE");
    const start = performance.now();
    const id = helper.send({
      kind: "query",
      queryId: "all",
      bindings: {},
      maxRows: 10,
      maxBytes: 10000,
      timeoutMs: action === "deadline" ? 80 : 5000,
    });
    assert.deepEqual(await helper.next(), { kind: "started", id });
    await delay(20);
    if (action === "cancel") helper.send({ kind: "cancel" });
    if (action === "eof") helper.child.stdin.end();
    const exit = await bounded(helper.exited, 2000);
    assert.equal(
      exit.code,
      action === "cancel" ? 66 : action === "eof" ? 69 : 67,
    );
    assert.ok(performance.now() - start < 900);
    source.database.exec(
      "ROLLBACK; UPDATE items SET value='producer-still-works'",
    );
  }
});

test("a queued request deadline expires while an earlier native query is blocked", async (t) => {
  const source = fixture(t, { wal: false });
  const helper = new Helper(t);
  await helper.hello();
  await helper.open(source.file);
  source.database.exec("BEGIN EXCLUSIVE");
  const first = helper.send({
    kind: "query",
    queryId: "all",
    bindings: {},
    maxRows: 10,
    maxBytes: 10000,
    timeoutMs: 5000,
  });
  assert.deepEqual(await helper.next(), { kind: "started", id: first });
  const started = performance.now();
  helper.send({
    kind: "query",
    queryId: "ids",
    bindings: {},
    maxRows: 10,
    maxBytes: 10000,
    timeoutMs: 80,
  });
  assert.equal((await bounded(helper.exited, 1500)).code, 67);
  assert.ok(performance.now() - started < 900);
  source.database.exec("ROLLBACK; UPDATE items SET value='still-usable'");
});

test("partial frames and idle helpers cannot outlive their fixed lifetime", async (t) => {
  const helper = new Helper(t, 150);
  await helper.hello();
  helper.child.stdin.write(Buffer.from([0, 0]));
  assert.equal((await bounded(helper.exited, 2000)).code, 67);
});

test("journals retain a controlled category distinct from diagnosed recovery", async (t) => {
  const source = fixture(t, { wal: false });
  writeFileSync(source.file + "-journal", "");
  const helper = new Helper(t);
  await helper.hello();
  assert.equal((await helper.open(source.file)).code, "JOURNAL_PRESENT");
  assert.equal((await bounded(helper.exited)).code, 70);
});

test(
  "the absolute row, result-byte and query-count boundaries are enforced",
  { timeout: 60_000 },
  async (t) => {
    const rows = fixture(t, { count: 10_000 });
    const exactRows = new Helper(t);
    await exactRows.hello();
    await exactRows.open(rows.file);
    assert.equal((await exactRows.query("ids")).rows.length, 10_000);
    assert.equal((await exactRows.query("ids")).code, "LIMIT");
    await bounded(exactRows.exited);
    rows.database.exec("INSERT INTO items(id) VALUES(1)");
    const overRows = new Helper(t);
    await overRows.hello();
    await overRows.open(rows.file);
    assert.equal((await overRows.query("ids")).code, "LIMIT");
    await bounded(overRows.exited);

    const source = fixture(t, { count: 1, value: "" });
    const baseline = new Helper(t);
    await baseline.hello();
    await baseline.open(source.file);
    const binding = { id: { type: "integer", value: "9007199254740993" } };
    const overhead = (await baseline.query("one", binding)).bytes;
    await baseline.close();
    for (const extra of [0, 1]) {
      source.database
        .prepare("UPDATE items SET value=?")
        .run("x".repeat(MAX_RESULT - overhead + extra));
      const helper = new Helper(t);
      await helper.hello();
      await helper.open(source.file);
      const result = await helper.query("one", binding);
      if (extra === 0) {
        assert.equal(result.kind, "rows");
        assert.equal(result.bytes, MAX_RESULT);
        await helper.close();
      } else {
        assert.equal(result.kind, "error");
        assert.equal(result.code, "LIMIT");
        await bounded(helper.exited);
      }
    }

    const empty = fixture(t, { count: 0 });
    for (const extra of [false, true]) {
      const helper = new Helper(t);
      await helper.hello();
      await helper.open(empty.file);
      for (let i = 0; i < 256; i++)
        assert.equal((await helper.query("ids")).rows.length, 0);
      if (extra) {
        assert.equal((await helper.query("ids")).code, "LIMIT");
        await bounded(helper.exited);
      } else await helper.close();
    }
  },
);

test("a full request frame and binding budget are accepted, but one-over bindings fail", async (t) => {
  const source = fixture(t, { count: 0 });
  const schema = {
    ...definition,
    queries: [
      {
        id: "text",
        table: "items",
        columns: ["id"],
        filters: [{ column: "value", parameter: "value" }],
      },
    ],
  };
  const helper = new Helper(t);
  await helper.hello();
  const payload = JSON.stringify({
    kind: "open",
    id: 1,
    protocolVersion: 1,
    path: source.file,
    definition: schema,
    timeoutMs: 5000,
  });
  helper.send({}, Buffer.from(payload.padEnd(MAX_REQUEST, " ")));
  assert.equal((await helper.next()).kind, "started");
  assert.equal((await helper.next()).kind, "opened");
  assert.equal(
    (
      await helper.query("text", {
        value: { type: "text", value: "x".repeat(8192 - 15) },
      })
    ).kind,
    "rows",
  );
  assert.equal(
    (
      await helper.query("text", {
        value: { type: "text", value: "x".repeat(8192 - 14) },
      })
    ).code,
    "LIMIT",
  );
  await bounded(helper.exited);
});

test("ordinary native lock timeout and schema drift remain explicit errors", async (t) => {
  const source = fixture(t, { wal: false });
  const helper = new Helper(t);
  await helper.hello();
  await helper.open(source.file, { ...definition, userVersions: [1, 2] });
  source.database.exec("PRAGMA user_version=2");
  assert.equal((await helper.query()).code, "SCHEMA");
  await bounded(helper.exited);
  const locked = new Helper(t);
  await locked.hello();
  await locked.open(source.file, { ...definition, userVersions: [2] });
  source.database.exec("BEGIN EXCLUSIVE");
  assert.equal((await locked.query()).code, "BUSY");
  await bounded(locked.exited);
  source.database.exec("ROLLBACK");
});

test("cancellation still exits while a large success frame is blocked on stdout", async (t) => {
  const source = fixture(t, { count: 1, value: "x".repeat(4 * 1024 * 1024) });
  const helper = new Helper(t);
  await helper.hello();
  await helper.open(source.file);
  const paused = new Promise((resolve) => {
    helper.pauseLargeReply = resolve;
  });
  helper.send({
    kind: "query",
    queryId: "all",
    bindings: {},
    maxRows: 10,
    maxBytes: MAX_RESULT,
    timeoutMs: 5000,
  });
  assert.equal((await helper.next()).kind, "started");
  await bounded(paused);
  await delay(20);
  const exit = once(helper.child, "exit");
  helper.send({ kind: "cancel" });
  assert.equal((await bounded(exit, 1000))[0], 66);
  helper.child.stdout.resume();
  await bounded(helper.exited);
  assert.ok(
    helper.buffer.length > 4,
    "Expected a truncated frame, not a fully written success",
  );
  assert.equal(
    helper.queue.some((message) => message.kind === "rows"),
    false,
  );
});

test("broken output and channel loss terminate the owned helper without payload logs", async (t) => {
  const source = fixture(t);
  const helper = new Helper(t);
  await helper.hello();
  await helper.open(source.file);
  helper.child.stdout.destroy();
  helper.send({
    kind: "query",
    queryId: "all",
    bindings: {},
    maxRows: 10,
    maxBytes: MAX_RESULT,
    timeoutMs: 5000,
  });
  assert.equal((await bounded(helper.exited)).code, 69);
  assert.ok(!helper.stderr.includes("fixture"));
});

test("schema admission rejects views, generated columns and malformed declarations before data reads", async (t) => {
  const source = fixture(t);
  source.database.exec(
    "CREATE VIEW alias AS SELECT id FROM items; CREATE TABLE generated(id INTEGER PRIMARY KEY, extra INTEGER GENERATED ALWAYS AS (id+1))",
  );
  for (const [table, columns] of [
    ["alias", ["id"]],
    ["generated", ["id", "extra"]],
  ]) {
    const helper = new Helper(t);
    await helper.hello();
    const schema = {
      userVersions: [1],
      tables: [{ name: table, columns, primaryKey: ["id"] }],
      queries: [{ id: "all", table, columns, filters: [] }],
    };
    assert.equal((await helper.open(source.file, schema)).code, "SCHEMA");
    await bounded(helper.exited);
  }
  const helper = new Helper(t);
  await helper.hello();
  const invalid = structuredClone(definition);
  invalid.queries[0].columns = ["value"];
  assert.equal(
    (await helper.open(path.join(source.root, "missing.db"), invalid)).code,
    "SCHEMA",
  );
  await bounded(helper.exited);
});

test("empty blobs, null/text/real keys and unusual real values remain exact or explicitly unsupported", async (t) => {
  const source = fixture(t, { count: 0 });
  source.database
    .prepare("INSERT INTO items VALUES(?,?,?,?,?,?)")
    .run(
      -9223372036854775808n,
      "embedded\u0000text",
      Number.MIN_VALUE,
      Buffer.alloc(0),
      null,
      "{}",
    );
  source.database.exec(
    "CREATE TABLE real_keys(id REAL PRIMARY KEY); INSERT INTO real_keys VALUES(1e21); CREATE TABLE text_keys(id TEXT PRIMARY KEY)",
  );
  source.database
    .prepare("INSERT INTO text_keys VALUES(?)")
    .run("key\u0000\u{1f980}");
  const schema = structuredClone(definition);
  for (const table of ["real_keys", "text_keys"]) {
    schema.tables.push({ name: table, columns: ["id"], primaryKey: ["id"] });
    schema.queries.push({ id: table, table, columns: ["id"], filters: [] });
  }
  const helper = new Helper(t);
  await helper.hello();
  await helper.open(source.file, schema);
  const original = (await helper.query()).rows[0];
  assert.deepEqual(original.values.id, {
    type: "integer",
    value: "-9223372036854775808",
  });
  assert.deepEqual(original.values.blob, { type: "blob", value: "" });
  assert.equal(original.values.real.value, Number.MIN_VALUE);
  assert.equal(original.values.value.value, "embedded\u0000text");
  assert.equal(
    original.fingerprint,
    createHash("sha256")
      .update(witness(schema.queries[0].columns, original.values))
      .digest("hex"),
  );
  const real = (await helper.query("real_keys")).rows[0];
  assert.deepEqual(real.key, [{ column: "id", type: "real", value: "1e+21" }]);
  const text = (await helper.query("text_keys")).rows[0];
  assert.equal(text.key[0].value, "key\u0000\u{1f980}");
  await helper.close();
  source.database.exec(
    "CREATE TABLE null_keys(id TEXT PRIMARY KEY); INSERT INTO null_keys VALUES(NULL); CREATE TABLE blob_keys(id BLOB PRIMARY KEY); INSERT INTO blob_keys VALUES(x'00')",
  );
  for (const table of ["null_keys", "blob_keys"]) {
    const invalid = new Helper(t);
    await invalid.hello();
    await invalid.open(source.file, {
      userVersions: [1],
      tables: [{ name: table, columns: ["id"], primaryKey: ["id"] }],
      queries: [{ id: "all", table, columns: ["id"], filters: [] }],
    });
    assert.equal((await invalid.query()).code, "DATA");
    await bounded(invalid.exited);
  }
});

test("missing, malformed and unreadable sources are not reported as empty results", async (t) => {
  const source = fixture(t);
  const malformed = path.join(source.root, "malformed.db");
  writeFileSync(malformed, "SECRET_CANARY".repeat(10));
  for (const [file, code] of [
    [path.join(source.root, "missing.db"), "SOURCE_UNAVAILABLE"],
    [malformed, "DATA"],
  ]) {
    const helper = new Helper(t);
    await helper.hello();
    const result = await helper.open(file);
    assert.equal(result.kind, "error");
    assert.equal(result.code, code);
    assert.equal((await bounded(helper.exited)).code, 70);
    assert.ok(!helper.stderr.includes("SECRET_CANARY"));
  }
  if (process.platform !== "win32" && process.getuid() !== 0) {
    const wal = source.file + "-wal";
    chmodSync(wal, 0);
    try {
      const helper = new Helper(t);
      await helper.hello();
      assert.equal((await helper.open(source.file)).code, "ACCESS_DENIED");
      await bounded(helper.exited);
    } finally {
      chmodSync(wal, 0o600);
    }
  }
});
