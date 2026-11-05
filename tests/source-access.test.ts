/**
 * Exercise the real read-only SQLite process and composite runtime with owned
 * synthetic databases/files only. No private captures or model process is used.
 * TestContext owns all resources; cancellation assertions observe actual child exit.
 */
import assert from "node:assert/strict";
import nodeTest, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  rename,
  stat,
  truncate,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseReadView,
  referenceSchema,
  type ReadView,
} from "../src/evidence/contracts.js";
import {
  sqliteDefinitionSchema,
  type MultiSourceReader,
  type MultiSourceInput,
  type SqliteDefinition,
  type SqliteInput,
} from "../src/evidence/source-access.js";
import { SourceAccess, MAX_SOURCE_BYTES } from "../src/runtime/sources.js";
import { SourceReadSet, sqliteReference } from "../src/runtime/source-read.js";
import { SqliteSource } from "../src/runtime/sqlite.js";
import {
  MAX_SQLITE_ROWS,
  MAX_SQLITE_RESULT_BYTES,
  MAX_SQLITE_BINDING_BYTES,
  SqliteFrames,
} from "../src/runtime/sqlite-protocol.js";
import { RuntimeService } from "../src/runtime/service.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { readSetRequestSchema, statusSchema } from "../src/runtime/protocol.js";
import { startRuntime } from "../src/runtime/server.js";
import { syntheticProvider } from "./fixtures/analysis.js";
import { testNativeHelper } from "./fixtures/native-helper.js";
import { nativeUnavailable } from "../src/runtime/native-helper.js";

/** Real native scenarios run only with an explicitly prepared candidate; unsupported/no-artifact ordinary hosts keep file-only tests. */
const test = (name: string, run: (t: TestContext) => Promise<void>): void => {
  void nodeTest(
    name,
    { skip: !process.env.AGENT_INSIGHTS_TEST_NATIVE_ROOT },
    run,
  );
};

/** Owned fixture resources, with source-reader cleanup ordered before writer/directory teardown. */
interface Fixture {
  readonly root: string;
  readonly file: string;
  readonly database: string;
  readonly writer: DatabaseSync;
  readonly cleanup: (() => Promise<void>)[];
}

/**
 * Create independently authored synthetic sources; the writer can simulate concurrent commits/locks.
 * @param t - Owns final cleanup.
 * @param wal - Keep live WAL/SHM sidecars via an open fixture writer when true.
 */
async function fixture(t: TestContext, wal = false): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-sqlite-"));
  const file = path.join(root, "events.json");
  const database = path.join(root, "source.db");
  await writeFile(file, '{"synthetic":true}');
  const writer = new DatabaseSync(database);
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    try {
      for (const close of cleanup.reverse()) await close();
    } finally {
      if (writer.isOpen) writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  if (wal) writer.exec("PRAGMA journal_mode=WAL");
  writer.exec(
    "PRAGMA user_version=1; CREATE TABLE items(id TEXT PRIMARY KEY, payload TEXT, amount INTEGER)",
  );
  writer
    .prepare("INSERT INTO items VALUES(?,?,?)")
    .run("row-1", '{"answer":"fictional"}', 7);
  return { root, file, database, writer, cleanup };
}

/**
 * Hold a native lock in a different process, as the real harness does.
 * POSIX closes on parent-owned descriptors must not inadvertently release the writer's locks.
 */
async function lockWriter(data: Fixture): Promise<void> {
  const child = childProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.argv[1]);
    database.exec("BEGIN EXCLUSIVE");
    process.send("locked");
    process.on("disconnect", () => { database.exec("ROLLBACK"); database.close(); });
  `,
      data.database,
    ],
    {
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  data.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fixture writer failed to acquire its lock")),
      5000,
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message === "locked") resolve();
      else reject(new Error("Invalid writer reply"));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Fixture writer exited early"));
    });
  });
}

/** Exact fixture schema with fixed projections; even a read request cannot supply SQL. */
function definition(): SqliteDefinition {
  return sqliteDefinitionSchema.parse({
    userVersions: [1],
    tables: [
      {
        name: "items",
        columns: ["id", "payload", "amount"],
        primaryKey: ["id"],
      },
    ],
    queries: [
      {
        id: "by_id",
        table: "items",
        columns: ["id", "payload", "amount"],
        filters: [{ column: "id", parameter: "id" }],
      },
      {
        id: "all_rows",
        table: "items",
        columns: ["id", "payload", "amount"],
        filters: [],
      },
      {
        id: "by_answer",
        table: "items",
        columns: ["id", "payload", "amount"],
        filters: [
          { column: "payload", parameter: "answer", jsonPath: ["answer"] },
        ],
      },
    ],
  });
}

/** Return the declared SQLite role or fail the test, never a successful empty fallback. */
function databaseInput(input: MultiSourceInput): SqliteInput {
  const database = input.get("database");
  assert.ok(database.available && database.kind === "sqlite");
  return database;
}

/**
 * Build a fixture-only view from genuinely captured rows/anchors.
 * @param input - Current runtime generation.
 * @param reader - Declared role list used to retain unavailable inputs too.
 */
async function view(
  input: MultiSourceInput,
  reader: MultiSourceReader,
): Promise<ReadView> {
  const database = databaseInput(input);
  const rows = await database.query("by_id", { id: "row-1" });
  const row = rows[0];
  assert.ok(row);
  const reference = sqliteReference(
    database.sourceId,
    row,
    "payload",
    "/answer",
  );
  return parseReadView({
    schemaVersion: 1,
    id: input.readId,
    startedAtMs: 1,
    finishedAtMs: 2,
    sources: reader.inputs.map((requirement) => {
      const source = input.get(requirement.key);
      return {
        id: source.sourceId,
        format: source.available ? requirement.format : null,
        identity: {
          producer: "fixture",
          version: null,
          executionHost: "unknown",
        },
        changedDuringRead: null,
        coverage: {
          messages: source.available
            ? { status: "complete" }
            : { status: "unavailable", reason: "Fixture source missing" },
          timing: { status: "unavailable", reason: "No recorded timing" },
          tools: { status: "unavailable", reason: "No recorded tools" },
          tokens: { status: "unavailable", reason: "No recorded usage" },
        },
      };
    }),
    sessions: [
      {
        id: "fictional-session",
        nativeId: "fictional",
        sourceIds: [database.sourceId],
        references: [reference],
      },
    ],
    events: [
      {
        id: "fictional-message",
        nativeId: "message-1",
        parentNativeId: null,
        sessionId: "fictional-session",
        references: [reference],
        kind: "message",
        role: "user",
        instructionId: "message-1",
        text: "Fictional source",
        timestampMs: null,
      },
    ],
    issues: [],
  });
}

/** Produce one trusted fixture reader; additional role requirements are supplied only in test code. */
function reader(extra: MultiSourceReader["inputs"] = []): MultiSourceReader {
  return {
    id: "fictional",
    inputs: [
      {
        key: "database",
        kind: "sqlite",
        format: "vscode-agenthost-session-sqlite",
        database: definition(),
      },
      ...extra,
    ],
    read(input) {
      return view(input, this);
    },
  };
}

/**
 * Open a composite source owner directly for low-level query/cleanup assertions.
 * @param data - Test-owned root/writer/cleanup stack.
 * @param adapter - Trusted fixture reader; not registered in ordinary application startup.
 * @param signal - Optional cancellation owned by the test.
 */
async function openSet(
  data: Fixture,
  adapter = reader(),
  signal = new AbortController().signal,
): Promise<SourceReadSet> {
  const set = new SourceReadSet(
    "read-fictional",
    signal,
    await SourceAccess.create([data.root]),
    adapter,
    testNativeHelper,
  );
  data.cleanup.push(() => set.dispose());
  await set.prepare(
    adapter.inputs.map((input) => ({
      key: input.key,
      sourceId: "source-1",
      relativePath:
        input.key === "database"
          ? "source.db"
          : input.key === "file"
            ? "events.json"
            : "missing.db",
    })),
  );
  return set;
}

/** Test-only runtime config, using no real installed model executable. */
function config(root: string) {
  return {
    sources: [root],
    port: 0,
    harness: "copilot" as const,
    model: null,
    copilotPath: path.join(root, "no-model"),
  };
}

/** Assert the exact controlled error rather than accepting arbitrary driver or payload-bearing exceptions. */
function code(expected: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, expected);
    assert.doesNotMatch(
      error.message,
      /PRIVATE_MARKER|DROP TABLE|SELECT .*FROM|source\.db/,
    );
    return true;
  };
}

test("read-only projections preserve exact integers, row anchors and source bytes", async (t) => {
  const data = await fixture(t);
  const before = createHash("sha256")
    .update(await readFile(data.database))
    .digest("hex");
  const set = await openSet(data);
  const database = databaseInput(set);
  assert.equal(database.userVersion, 1);
  const rows = await database.query("by_id", { id: "row-1" });
  assert.equal(rows[0]?.values.amount, 7n);
  const row = rows[0];
  assert.ok(row);
  const reference = referenceSchema.parse(
    sqliteReference(database.sourceId, row, "payload", "/answer"),
  );
  assert.equal(reference.location.kind, "sqlite");
  if (reference.location.kind !== "sqlite")
    throw new Error("Expected SQLite reference");
  assert.deepEqual(reference.location.key, [
    { column: "id", type: "text", value: "row-1" },
  ]);
  assert.match(reference.location.fingerprint, /^[a-f0-9]{64}$/);
  const observations = await set.finish();
  assert.equal(observations[0]?.changed, false);
  assert.equal(observations[0]?.userVersion, 1);
  await set.dispose();
  assert.equal(
    createHash("sha256")
      .update(await readFile(data.database))
      .digest("hex"),
    before,
  );
  assert.deepEqual((await readdir(data.root)).sort(), [
    "events.json",
    "source.db",
  ]);
});

test("SQL-like captured values are bindings, while unknown queries and identifiers are rejected", async (t) => {
  const data = await fixture(t);
  data.writer
    .prepare("INSERT INTO items VALUES(?,?,?)")
    .run("'; DROP TABLE items; --", "fictional", 1);
  const set = await openSet(data);
  const rows = await databaseInput(set).query("by_id", {
    id: "'; DROP TABLE items; --",
  });
  assert.equal(rows.length, 1);
  assert.equal(
    data.writer.prepare("SELECT count(*) AS n FROM items").get()?.n,
    2,
  );
  for (const operation of [
    "SELECT * FROM items",
    "UPDATE items SET amount=0",
    "ATTACH DATABASE 'PRIVATE_MARKER' AS other",
    "SELECT load_extension('PRIVATE_MARKER')",
    "PRAGMA query_only=OFF",
  ])
    await assert.rejects(
      databaseInput(set).query(operation, {}),
      code("SQLITE_QUERY"),
    );
  await assert.rejects(set.finish(), code("SQLITE_QUERY"));
  assert.equal(
    sqliteDefinitionSchema.safeParse({
      ...definition(),
      queries: [
        {
          id: "attack",
          table: "items; ATTACH DATABASE x",
          columns: ["id"],
          filters: [],
        },
      ],
    }).success,
    false,
  );
});

test("query parameters must match the declared filter names exactly", async (t) => {
  const data = await fixture(t);
  for (const bindings of [{}, { id: "row-1", other: "PRIVATE_MARKER" }]) {
    const set = await openSet(data);
    await assert.rejects(
      databaseInput(set).query("by_id", bindings),
      code("SQLITE_BINDINGS"),
    );
    await set.dispose();
  }
});

test("JSON field equality is a code-owned projection and malformed source JSON is explicit", async (t) => {
  const data = await fixture(t);
  const set = await openSet(data);
  assert.equal(
    (await databaseInput(set).query("by_answer", { answer: "fictional" }))
      .length,
    1,
  );
  await set.finish();
  await set.dispose();
  data.writer
    .prepare("UPDATE items SET payload=?")
    .run("PRIVATE_MARKER invalid json");
  const bad = await openSet(data);
  await assert.rejects(
    databaseInput(bad).query("by_answer", { answer: "fictional" }),
    code("SQLITE_DATA"),
  );
});

test("unknown versions, views, generated columns and wrong primary keys cannot be silently admitted", async (t) => {
  const data = await fixture(t);
  data.writer.exec(
    "CREATE VIEW view_items AS SELECT * FROM items; CREATE TABLE generated(id TEXT PRIMARY KEY, payload TEXT GENERATED ALWAYS AS ('x'), amount INTEGER); CREATE VIRTUAL TABLE virtual_items USING fts5(id, payload, amount)",
  );
  for (const database of [
    { ...definition(), userVersions: [999] },
    {
      ...definition(),
      tables: [
        {
          name: "items",
          columns: ["id", "payload", "amount"],
          primaryKey: ["payload"],
        },
      ],
    },
    ...["view_items", "generated", "virtual_items"].map((name) => ({
      userVersions: [1],
      tables: [
        { name, columns: ["id", "payload", "amount"], primaryKey: ["id"] },
      ],
      queries: [
        {
          id: "by_id",
          table: name,
          columns: ["id", "payload", "amount"],
          filters: [],
        },
      ],
    })),
  ]) {
    const adapter: MultiSourceReader = {
      ...reader(),
      inputs: [
        {
          key: "database",
          kind: "sqlite",
          format: "vscode-agenthost-session-sqlite",
          database,
        },
      ],
    };
    await assert.rejects(openSet(data, adapter), code("SQLITE_SCHEMA"));
  }
});

test("binary cells and primary keys above JavaScript's safe integer range retain exact identity", async (t) => {
  const data = await fixture(t);
  data.writer.exec(
    "DROP TABLE items; CREATE TABLE items(id INTEGER PRIMARY KEY, payload BLOB, amount INTEGER)",
  );
  const payload = new Uint8Array([0, 255, 42]);
  data.writer
    .prepare("INSERT INTO items VALUES(?,?,?)")
    .run(9007199254740993n, payload, 9223372036854775807n);
  const set = await openSet(data);
  const row = (
    await databaseInput(set).query("by_id", { id: 9007199254740993n })
  )[0];
  assert.ok(row);
  assert.equal(row.values.amount, 9223372036854775807n);
  assert.deepEqual(row.values.payload, payload);
  assert.deepEqual(row.key, [
    { column: "id", type: "integer", value: "9007199254740993" },
  ]);
  await assert.rejects(
    databaseInput(set).query("by_id", { id: 9223372036854775808n }),
    code("SQLITE_BINDINGS"),
  );
});

test("WAL snapshots see committed data, retain one transaction and report concurrent changes", async (t) => {
  const data = await fixture(t, true);
  const set = await openSet(data);
  const database = databaseInput(set);
  assert.equal(
    (await database.query("by_id", { id: "row-1" }))[0]?.values.amount,
    7n,
  );
  data.writer.prepare("UPDATE items SET amount=? WHERE id=?").run(8, "row-1");
  assert.equal(
    (await database.query("by_id", { id: "row-1" }))[0]?.values.amount,
    7n,
  );
  const observations = await set.finish();
  assert.equal(observations[0]?.changed, true);
  await set.dispose();
  const refreshed = await openSet(data);
  assert.equal(
    (await databaseInput(refreshed).query("by_id", { id: "row-1" }))[0]?.values
      .amount,
    8n,
  );
});

test("a WAL source without existing sidecars is rejected rather than creating them", async (t) => {
  const data = await fixture(t);
  const file = path.join(data.root, "closed-wal.db");
  const writer = new DatabaseSync(file);
  writer.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE x(id INTEGER PRIMARY KEY); INSERT INTO x VALUES(1)",
  );
  writer.close();
  const before = await readdir(data.root);
  const access = await SourceAccess.create([data.root]);
  await assert.rejects(
    access.database("source-1", "closed-wal.db", new AbortController().signal),
    code("SQLITE_SIDECARS"),
  );
  assert.deepEqual(await readdir(data.root), before);
});

test("database grants reject traversal, sidecar links and retargeted main sources", async (t) => {
  const data = await fixture(t);
  const access = await SourceAccess.create([data.database]);
  await assert.rejects(
    access.database("source-1", "../source.db", new AbortController().signal),
    code("SOURCE_SCOPE"),
  );
  if (process.platform !== "win32") {
    await symlink(data.file, data.database + "-wal");
    await assert.rejects(
      access.database("source-1", "", new AbortController().signal),
      code("SOURCE_LINK"),
    );
    await rm(data.database + "-wal");
  }
  const lease = await access.database(
    "source-1",
    "",
    new AbortController().signal,
  );
  data.cleanup.push(() => lease.close());
  if (process.platform !== "win32") {
    await rename(data.database, data.database + ".old");
    await writeFile(data.database, "replacement");
    await assert.rejects(lease.verify(), code("SOURCE_CHANGED"));
  }
});

test("optional missing database sources remain explicit unavailable inputs", async (t) => {
  const data = await fixture(t);
  const adapter = reader([
    {
      key: "missing",
      kind: "sqlite",
      optional: true,
      format: "vscode-agenthost-session-sqlite",
      database: definition(),
    },
  ]);
  const service = new RuntimeService(
    await SourceAccess.create([data.root]),
    config(data.root),
    [],
    30000,
    null,
    [adapter],
    testNativeHelper,
  );
  data.cleanup.push(() => service.close());
  const result = await service.readSet(
    {
      readerId: adapter.id,
      sources: [
        { key: "database", sourceId: "source-1", relativePath: "source.db" },
        { key: "missing", sourceId: "source-1", relativePath: "absent.db" },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(result.sources.length, 2);
  const missing = result.sources.find((source) =>
    source.id.endsWith(":missing"),
  );
  assert.equal(missing?.format, null);
  assert.equal(missing?.coverage.messages.status, "unavailable");
  assert.ok(result.issues.some((issue) => issue.code === "unreadable-source"));
});

test("multi-source reads preserve distinct source identities, timings and SQL witnesses", async (t) => {
  const data = await fixture(t);
  const adapter = reader([
    { key: "file", kind: "file", format: "copilot-sdk-events-jsonl" },
  ]);
  const service = new RuntimeService(
    await SourceAccess.create([data.root]),
    config(data.root),
    [],
    30000,
    null,
    [adapter],
    testNativeHelper,
  );
  data.cleanup.push(() => service.close());
  const selection = {
    readerId: adapter.id,
    sources: [
      { key: "database", sourceId: "source-1", relativePath: "source.db" },
      { key: "file", sourceId: "source-1", relativePath: "events.json" },
    ],
  };
  const result = await service.readSet(selection, new AbortController().signal);
  assert.equal(new Set(result.sources.map((source) => source.id)).size, 2);
  assert.equal(service.readTiming?.sources?.length, 2);
  assert.ok(
    service.readTiming &&
      service.readTiming.inputFinishedAtMs <= service.readTiming.finishedAtMs,
  );
  assert.equal(service.readTiming.finishedAtMs, result.finishedAtMs);
  assert.equal(result.events[0]?.references[0]?.location.kind, "sqlite");
  assert.ok(Object.isFrozen(service.selection));
  service.invalidate();
  assert.equal(service.view, null);
  assert.equal(service.readTiming, null);
});

test("fabricated database row/field references and role mismatches are rejected", async (t) => {
  const data = await fixture(t);
  const original = reader();
  const bad: MultiSourceReader = {
    ...original,
    async read(input) {
      const result = await view(input, this);
      return parseReadView({
        ...result,
        events: result.events.map((event) => ({
          ...event,
          references: event.references.map((reference) =>
            reference.location.kind !== "sqlite"
              ? reference
              : {
                  ...reference,
                  location: {
                    ...reference.location,
                    fingerprint: "0".repeat(64),
                  },
                },
          ),
        })),
      });
    },
  };
  const service = new RuntimeService(
    await SourceAccess.create([data.root]),
    config(data.root),
    [],
    30000,
    null,
    [bad],
    testNativeHelper,
  );
  data.cleanup.push(() => service.close());
  await assert.rejects(
    service.readSet(
      {
        readerId: bad.id,
        sources: [
          { key: "database", sourceId: "source-1", relativePath: "source.db" },
        ],
      },
      new AbortController().signal,
    ),
    code("INVALID_SQLITE_REFERENCE"),
  );
  assert.equal(service.view, null);
  await assert.rejects(
    service.readSet(
      {
        readerId: bad.id,
        sources: [
          { key: "other", sourceId: "source-1", relativePath: "source.db" },
        ],
      },
      new AbortController().signal,
    ),
    code("SOURCE_ROLES"),
  );
  assert.equal(
    readSetRequestSchema.safeParse({
      readerId: bad.id,
      sources: [],
      sql: "SELECT 1",
    }).success,
    false,
  );
});

test("the actual aggregate row limit accepts 10000 rows and rejects one additional row", async (t) => {
  const data = await fixture(t);
  data.writer.exec("DELETE FROM items; BEGIN");
  const insert = data.writer.prepare("INSERT INTO items VALUES(?,?,?)");
  for (let index = 0; index < MAX_SQLITE_ROWS; index++)
    insert.run(`row-${index}`, "", index);
  data.writer.exec("COMMIT");
  const set = await openSet(data);
  const database = databaseInput(set);
  assert.equal((await database.query("all_rows", {})).length, MAX_SQLITE_ROWS);
  await assert.rejects(
    database.query("by_id", { id: "row-1" }),
    code("SQLITE_LIMIT"),
  );
});

test("the actual binding byte limit accepts its boundary and rejects one more byte", async (t) => {
  const data = await fixture(t);
  // The canonical tagged binding is [["string", "<value>"]]; derive overhead without changing production limits.
  const overhead = Buffer.byteLength(JSON.stringify([["string", ""]]));
  const set = await openSet(data);
  const database = databaseInput(set);
  assert.equal(
    (
      await database.query("by_id", {
        id: "x".repeat(MAX_SQLITE_BINDING_BYTES - overhead),
      })
    ).length,
    0,
  );
  await assert.rejects(
    database.query("by_id", {
      id: "x".repeat(MAX_SQLITE_BINDING_BYTES - overhead + 1),
    }),
    code("SQLITE_LIMIT"),
  );
});

test("the actual query result byte limit is enforced before row transport", async (t) => {
  const data = await fixture(t);
  /** Open one fresh snapshot so fixture writes between checks cannot be hidden by a previous transaction. */
  async function query(): Promise<number> {
    const lease = await (
      await SourceAccess.create([data.root])
    ).database("source-1", "source.db", new AbortController().signal);
    const source = new SqliteSource(
      lease,
      new AbortController().signal,
      testNativeHelper,
    );
    try {
      await source.initialize(definition());
      const result = await source.query(
        "by_id",
        { id: "row-1" },
        MAX_SQLITE_ROWS,
        MAX_SQLITE_RESULT_BYTES,
      );
      await source.close();
      return result.bytes;
    } finally {
      await source.stop();
      await lease.close();
    }
  }
  data.writer.prepare("UPDATE items SET payload=''").run();
  const overhead = await query();
  data.writer
    .prepare("UPDATE items SET payload=?")
    .run("x".repeat(MAX_SQLITE_RESULT_BYTES - overhead));
  assert.equal(await query(), MAX_SQLITE_RESULT_BYTES);
  data.writer
    .prepare("UPDATE items SET payload=?")
    .run("x".repeat(MAX_SQLITE_RESULT_BYTES - overhead + 1));
  await assert.rejects(query(), code("SQLITE_LIMIT"));
});

test("cancellation and deadlines terminate the actual SQLite process while a writer holds its lock", async (t) => {
  const data = await fixture(t);
  const originalSpawn = childProcess.spawn;
  const children: ChildProcess[] = [];
  let started: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => {
    started = resolve;
  });
  const mock = t.mock.method(
    childProcess,
    "spawn",
    (...args: Parameters<typeof childProcess.spawn>) => {
      const child = originalSpawn(...args);
      if (!Array.isArray(args[1]) || !args[1].includes("--parent-pid"))
        return child;
      children.push(child);
      const frames = new SqliteFrames();
      child.stdout?.on("data", (chunk: Buffer) =>
        frames.push(chunk, (reply) => {
          if (reply.kind === "started") started?.();
        }),
      );
      return child;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  await lockWriter(data);
  const controller = new AbortController();
  const pending = openSet(data, reader(), controller.signal);
  const rejected = assert.rejects(pending, code("READ_CANCELLED"));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      observed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("SQLite process did not enter the operation")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await delay(50);
  assert.equal(
    settled,
    false,
    "The native operation must actually be waiting for the writer's lock",
  );
  const start = performance.now();
  controller.abort();
  await rejected;
  await data.cleanup.at(-1)?.();
  assert.ok(
    performance.now() - start < 2000,
    "Cancellation must stop native lock waiting, not merely stop awaiting it",
  );
  assert.ok(
    children.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    ),
  );
  const service = new RuntimeService(
    await SourceAccess.create([data.root]),
    config(data.root),
    [],
    150,
    null,
    [reader()],
    testNativeHelper,
  );
  data.cleanup.push(() => service.close());
  const deadlineStart = performance.now();
  await assert.rejects(
    service.readSet(
      {
        readerId: "fictional",
        sources: [
          { key: "database", sourceId: "source-1", relativePath: "source.db" },
        ],
      },
      new AbortController().signal,
    ),
    code("READ_TIMEOUT"),
  );
  assert.ok(performance.now() - deadlineStart < 2000);
  assert.ok(
    children.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    ),
  );
  assert.equal(service.view, null);
});

test("native lock exhaustion is explicit and never becomes a successful empty query", async (t) => {
  const data = await fixture(t);
  await lockWriter(data);
  await assert.rejects(openSet(data), code("SQLITE_LOCKED"));
});

test("empty queries still consume the aggregate query-count budget", async (t) => {
  const data = await fixture(t);
  const set = await openSet(data);
  for (let index = 0; index < 256; index++)
    assert.equal(
      (await databaseInput(set).query("by_id", { id: "absent" })).length,
      0,
    );
  await assert.rejects(
    databaseInput(set).query("by_id", { id: "absent" }),
    code("READ_LIMIT"),
  );
  await assert.rejects(set.finish(), code("READ_LIMIT"));
});

test("combined file bytes and database-plus-sidecar bytes enforce the real 64 MiB ceiling", async (t) => {
  const data = await fixture(t);
  await truncate(data.file, MAX_SOURCE_BYTES);
  const adapter: MultiSourceReader = {
    ...reader(),
    inputs: [{ key: "file", kind: "file", format: "copilot-sdk-events-jsonl" }],
  };
  const accepted = await openSet(data, adapter);
  await accepted.finish();
  await accepted.dispose();
  const twoFiles: MultiSourceReader = {
    ...adapter,
    inputs: [
      ...adapter.inputs,
      { key: "another", kind: "file", format: "copilot-sdk-events-jsonl" },
    ],
  };
  await writeFile(path.join(data.root, "missing.db"), "x");
  await assert.rejects(openSet(data, twoFiles), code("READ_LIMIT"));
  const size = (await stat(data.database)).size;
  await writeFile(data.database + "-wal", "");
  await truncate(data.database + "-wal", MAX_SOURCE_BYTES - size);
  const access = await SourceAccess.create([data.root]);
  const lease = await access.database(
    "source-1",
    "source.db",
    new AbortController().signal,
  );
  await lease.close();
  await truncate(data.database + "-wal", MAX_SOURCE_BYTES - size + 1);
  await assert.rejects(
    access.database("source-1", "source.db", new AbortController().signal),
    code("SOURCE_TOO_LARGE"),
  );
});

test("cleanup failures block publication and further reads until retained ownership is cleaned", async (t) => {
  const data = await fixture(t);
  const adapter: MultiSourceReader = {
    ...reader(),
    async read() {
      throw new RuntimeError(
        "FIXTURE_FAILURE",
        "Synthetic normalization failure",
        422,
      );
    },
  };
  const service = new RuntimeService(
    await SourceAccess.create([data.root]),
    config(data.root),
    [],
    30000,
    null,
    [adapter],
    testNativeHelper,
  );
  data.cleanup.push(() => service.close());
  const selection = {
    readerId: adapter.id,
    sources: [
      { key: "database", sourceId: "source-1", relativePath: "source.db" },
    ],
  };
  const mocked = t.mock.method(SqliteSource.prototype, "stop", async () => {
    throw new RuntimeError(
      "SQLITE_CLEANUP_FAILED",
      "Synthetic cleanup failure",
      500,
    );
  });
  try {
    await assert.rejects(
      service.readSet(selection, new AbortController().signal),
      code("SOURCE_CLEANUP_FAILED"),
    );
    assert.equal(service.view, null);
    await assert.rejects(
      service.readSet(selection, new AbortController().signal),
      code("SOURCE_CLEANUP_FAILED"),
    );
  } finally {
    mocked.mock.restore();
  }
  await service.close();
  await assert.rejects(
    service.readSet(selection, new AbortController().signal),
    code("FIXTURE_FAILURE"),
  );
});

test("replacement reads await prior disposal and cannot publish across a cleanup failure", async (t) => {
  for (const failCleanup of [false, true]) {
    const data = await fixture(t);
    const access = await SourceAccess.create([data.root]);
    const originalDatabase = access.database.bind(access);
    let opens = 0;
    t.mock.method(
      access,
      "database",
      (...args: Parameters<SourceAccess["database"]>) => {
        opens++;
        return originalDatabase(...args);
      },
    );
    let releaseReader: (() => void) | undefined;
    const readerGate = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    let announceReader: (() => void) | undefined;
    const readerEntered = new Promise<void>((resolve) => {
      announceReader = resolve;
    });
    let readerCalls = 0;
    const adapter: MultiSourceReader = {
      ...reader(),
      async read(input) {
        const captured = await view(input, this);
        if (++readerCalls === 1) {
          announceReader?.();
          await readerGate;
        }
        return captured;
      },
    };
    const service = new RuntimeService(
      access,
      config(data.root),
      [],
      30000,
      null,
      [adapter],
      testNativeHelper,
    );
    data.cleanup.push(() => service.close());
    const selection = {
      readerId: adapter.id,
      sources: [
        { key: "database", sourceId: "source-1", relativePath: "source.db" },
      ],
    };
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let announceCleanup: (() => void) | undefined;
    const cleanupEntered = new Promise<void>((resolve) => {
      announceCleanup = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The fault wrapper below invokes the original with its actual owning read set.
    const originalDispose = SourceReadSet.prototype.dispose;
    let disposals = 0;
    const mocked = t.mock.method(
      SourceReadSet.prototype,
      "dispose",
      async function (this: SourceReadSet) {
        if (++disposals === 1) {
          announceCleanup?.();
          await cleanupGate;
          if (failCleanup)
            throw new RuntimeError(
              "SQLITE_CLEANUP_FAILED",
              "Synthetic delayed cleanup failure",
              500,
            );
        }
        await originalDispose.call(this);
      },
    );
    const first = service.readSet(selection, new AbortController().signal);
    await readerEntered;
    const second = service.readSet(selection, new AbortController().signal);
    const settled = Promise.allSettled([first, second]);
    let opensBeforeRelease: number;
    try {
      await cleanupEntered;
      await delay(0);
      opensBeforeRelease = opens;
    } finally {
      releaseCleanup?.();
      releaseReader?.();
    }
    const outcomes = await settled;
    mocked.mock.restore();
    assert.equal(
      opensBeforeRelease,
      1,
      "Replacement must not acquire sources before previous disposal finishes",
    );
    const prior = outcomes[0];
    assert.ok(prior?.status === "rejected");
    code(failCleanup ? "SOURCE_CLEANUP_FAILED" : "READ_CANCELLED")(
      prior.reason,
    );
    const replacement = outcomes[1];
    if (failCleanup) {
      assert.ok(replacement?.status === "rejected");
      code("SOURCE_CLEANUP_FAILED")(replacement.reason);
      assert.equal(service.view, null);
      await service.close();
      assert.ok(await service.readSet(selection, new AbortController().signal));
    } else {
      assert.ok(replacement?.status === "fulfilled");
      assert.equal(service.view, replacement.value);
    }
  }
});

test("composite cancellation rejects stale normalization and concurrent cleanup is idempotent", async (t) => {
  const data = await fixture(t);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const adapter: MultiSourceReader = {
    ...reader(),
    async read(input) {
      const captured = await view(input, this);
      announce?.();
      await gate;
      return captured;
    },
  };
  const service = new RuntimeService(
    await SourceAccess.create([data.root]),
    config(data.root),
    [],
    30000,
    null,
    [adapter],
    testNativeHelper,
  );
  data.cleanup.push(() => service.close());
  const pending = service.readSet(
    {
      readerId: adapter.id,
      sources: [
        { key: "database", sourceId: "source-1", relativePath: "source.db" },
      ],
    },
    new AbortController().signal,
  );
  const cancelled = assert.rejects(pending, code("READ_CANCELLED"));
  await entered;
  await Promise.all([service.close(), service.close()]);
  await cancelled;
  release?.();
  await delay(0);
  assert.equal(service.view, null);
  assert.equal(service.selection, null);
});

test("multi-megabyte blobs within the result budget retain exact bytes and provenance", async (t) => {
  const data = await fixture(t);
  const payload = Buffer.alloc(4 * 1024 * 1024, 0xa5);
  data.writer.prepare("UPDATE items SET payload=?").run(payload);
  const set = await openSet(data);
  const database = databaseInput(set);
  const rows = await database.query("all_rows", {});
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.ok(row.values.payload instanceof Uint8Array);
  assert.equal(row.values.payload.byteLength, payload.byteLength);
  assert.equal(
    createHash("sha256").update(row.values.payload).digest("hex"),
    createHash("sha256").update(payload).digest("hex"),
  );
  const reference = sqliteReference(database.sourceId, row, "payload");
  assert.equal(reference.location.kind, "sqlite");
  assert.match(row.fingerprint, /^[a-f0-9]{64}$/);
  await set.finish();
});

test("missing native preparation is fatal even for an optional database role", async (t) => {
  const data = await fixture(t);
  const adapter = reader();
  const optional = {
    ...adapter,
    inputs: adapter.inputs.map((input) => ({ ...input, optional: true })),
  };
  const set = new SourceReadSet(
    "read-native-missing",
    new AbortController().signal,
    await SourceAccess.create([data.root]),
    optional,
    () => Promise.reject(nativeUnavailable()),
  );
  data.cleanup.push(() => set.dispose());
  await assert.rejects(
    set.prepare([
      { key: "database", sourceId: "source-1", relativePath: "source.db" },
    ]),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "NATIVE_GUARD_UNAVAILABLE",
  );
});

test("an unreadable retained WAL is optional access unavailability, never malformed data or empty rows", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("Requires enforced POSIX file permissions");
    return;
  }
  const data = await fixture(t, true);
  const wal = path.join(data.root, "source.db-wal");
  await chmod(wal, 0);
  const adapter = reader();
  const optional = {
    ...adapter,
    inputs: adapter.inputs.map((input) => ({ ...input, optional: true })),
  };
  const set = new SourceReadSet(
    "read-unreadable-wal",
    new AbortController().signal,
    await SourceAccess.create([data.root]),
    optional,
    testNativeHelper,
  );
  try {
    await set.prepare([
      { key: "database", sourceId: "source-1", relativePath: "source.db" },
    ]);
    const source = set.get("database");
    assert.equal(source.available, false);
    if (!source || source.available) assert.fail();
    assert.equal(source.code, "SOURCE_DENIED");
  } finally {
    await set.dispose();
    await chmod(wal, 0o600);
  }
});

test("producer shutdown after parent verification never recreates removed WAL/SHM", async (t) => {
  const data = await fixture(t, true);
  data.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = await stat(data.database);
  const access = await SourceAccess.create([data.root]);
  const lease = await access.database(
    "source-1",
    "source.db",
    new AbortController().signal,
  );
  const verify = lease.verify.bind(lease);
  lease.verify = async () => {
    const changed = await verify();
    data.writer.close();
    return changed;
  };
  const owner = new SqliteSource(
    lease,
    new AbortController().signal,
    testNativeHelper,
  );
  data.cleanup.push(async () => {
    await owner.stop();
    await lease.close();
  });
  await assert.rejects(
    owner.initialize(definition()),
    (error: unknown) => error instanceof RuntimeError,
  );
  const after = await stat(data.database);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  for (const suffix of ["-wal", "-shm"])
    await assert.rejects(
      stat(data.database + suffix),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
});

test("rollback mode releases idle locks and exposes per-request observations", async (t) => {
  const data = await fixture(t);
  const set = await openSet(data);
  const database = databaseInput(set);
  assert.equal(database.snapshotScope, "request");
  assert.equal((await database.query("all_rows", {})).length, 1);
  data.writer.exec("INSERT INTO items VALUES ('row-2', 'second', 1)");
  assert.equal((await database.query("all_rows", {})).length, 2);
  assert.equal((await set.finish())[0]?.snapshotScope, "request");
});

test("the authenticated composite endpoint accepts only registered roles and never invokes analysis", async (t) => {
  const data = await fixture(t);
  let analysisCalls = 0;
  const runtime = await startRuntime(config(data.root), {
    multiSourceReaders: [reader()],
    nativeHelper: testNativeHelper,
    analysisProvider: {
      ...syntheticProvider,
      async analyze() {
        analysisCalls++;
        throw new Error("Analysis must not run");
      },
    },
  });
  data.cleanup.push(() => runtime.close());
  const headers = {
    "X-Agent-Insights-Token": runtime.token,
    Origin: runtime.origin,
    "Content-Type": "application/json",
  };
  const status = statusSchema.parse(
    await (await fetch(runtime.origin + "/api/status", { headers })).json(),
  );
  assert.equal(status.multiSourceReaders[0]?.id, "fictional");
  assert.equal(status.nativeSqlite.available, true);
  assert.doesNotMatch(
    JSON.stringify(status.multiSourceReaders),
    /queries|userVersions|primaryKey/,
  );
  const selection = {
    readerId: "fictional",
    sources: [
      { key: "database", sourceId: "source-1", relativePath: "source.db" },
    ],
  };
  assert.equal(
    (
      await fetch(runtime.origin + "/api/read-set", {
        method: "POST",
        headers: { Origin: runtime.origin },
        body: JSON.stringify(selection),
      })
    ).status,
    401,
  );
  const response = await fetch(runtime.origin + "/api/read-set", {
    method: "POST",
    headers,
    body: JSON.stringify(selection),
  });
  assert.equal(response.status, 200);
  const result = parseReadView(await response.json());
  assert.equal(result.events.length, 1);
  assert.equal(
    (
      await fetch(runtime.origin + "/api/read-set", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...selection, sql: "DROP TABLE items" }),
      })
    ).status,
    400,
  );
  assert.equal(analysisCalls, 0);
  await fetch(runtime.origin + "/api/refresh", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(
    statusSchema.parse(
      await (await fetch(runtime.origin + "/api/status", { headers })).json(),
    ).hasReadView,
    false,
  );
});
