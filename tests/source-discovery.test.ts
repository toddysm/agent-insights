/**
 * Synthetic discovery, correlation and combined-reader tests. Native cases run
 * only with the verified candidate; no private capture or model runtime is used.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SourceAccess } from "../src/runtime/sources.js";
import { SourceDiscovery } from "../src/runtime/discovery.js";
import { RuntimeService } from "../src/runtime/service.js";
import { startRuntime } from "../src/runtime/server.js";
import {
  discoveryRequestSchema,
  discoveryResultSchema,
  type DiscoveryRequest,
} from "../src/runtime/protocol.js";
import { agentHostSessionReader } from "../src/evidence/readers/agent-host-session.js";
import { productionMultiSourceReaders } from "../src/evidence/readers/index.js";
import type {
  MultiSourceInput,
  SqliteRow,
} from "../src/evidence/source-access.js";
import { testNativeHelper } from "./fixtures/native-helper.js";
import { syntheticProvider } from "./fixtures/analysis.js";

const signal = new AbortController().signal;
const native = { skip: !process.env.AGENT_INSIGHTS_TEST_NATIVE_ROOT };

/** Fictional format-1 records with pinned runtime identity, never source captures. */
function records(sdk = "sdk-fictional") {
  const envelope = { timestamp: "2026-11-03T10:00:00.001Z", parentId: "start" };
  return [
    {
      ...envelope,
      id: "start",
      type: "session.start",
      parentId: null,
      data: {
        sessionId: sdk,
        version: 1,
        producer: "copilot-agent",
        copilotVersion: "1.0.103-unstable.r41379698026.g3219c66",
      },
    },
    {
      ...envelope,
      id: "user",
      type: "user.message",
      data: { content: "Fictional request", messageId: "message" },
    },
    {
      ...envelope,
      id: "tool-start",
      type: "tool.execution_start",
      data: { toolCallId: "call", toolName: "read" },
    },
    {
      ...envelope,
      id: "tool-end",
      type: "tool.execution_complete",
      data: {
        toolCallId: "call",
        success: true,
        result: { content: "Fictional result" },
      },
    },
  ];
}

/** Projection witnesses model one authoritative default chat, independent of filesystem names. */
function catalogRows(): SqliteRow[] {
  const values: { table: string; key: string; values: SqliteRow["values"] }[] =
    [
      {
        table: "chats_v2",
        key: "chat_uri",
        values: {
          chat_uri: "copilotcli:/host/chat",
          owner_session_uri: "copilotcli:/host",
          storage_resource: "copilotcli:/sdk-fictional",
          provider_data: '{"sdkSessionId":"sdk-fictional"}',
          parent_chat: null,
          tombstoned: 0n,
          archived: 0n,
          origin_session_uri: null,
        },
      },
      {
        table: "sessions_v2",
        key: "session_uri",
        values: {
          session_uri: "copilotcli:/host",
          provider: "copilotcli",
          session_generation: "g1",
          verified: 1n,
          is_chat_backing: 0n,
        },
      },
      {
        table: "session_chat_catalogs",
        key: "session_uri",
        values: {
          session_uri: "copilotcli:/host",
          authority_version: 2n,
          session_generation: "g1",
          revision: 1n,
          projected_revision: 1n,
        },
      },
    ];
  return values.map((entry) => ({
    table: entry.table,
    values: entry.values,
    fingerprint: "a".repeat(64),
    key: [
      {
        column: entry.key,
        type: "text",
        value: String(entry.values[entry.key]),
      },
    ],
  }));
}

/** Own a temporary source tree and remove it only after the test's resource owners close. */
async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("combined session reads frame history and resolve catalog once without merging message/execution identities", async () => {
  let iterations = 0;
  const queries: string[] = [];
  const input: MultiSourceInput = {
    readId: "synthetic",
    signal,
    get(key) {
      if (key === "history")
        return {
          available: true,
          kind: "file",
          sourceId: "history",
          bytes: {
            async *[Symbol.asyncIterator]() {
              assert.equal(
                ++iterations,
                1,
                "The combined reader must parse history once.",
              );
              yield Buffer.from(
                records()
                  .map((item) => JSON.stringify(item))
                  .join("\n") + "\n",
              );
            },
          },
        };
      if (key === "overlay")
        return {
          available: false,
          sourceId: "overlay",
          code: "SOURCE_UNAVAILABLE",
          reason: "Not selected.",
        };
      assert.equal(key, "catalog");
      return {
        available: true,
        kind: "sqlite",
        sourceId: "catalog",
        userVersion: 22,
        snapshotScope: "connection",
        async query(query) {
          queries.push(query);
          const table =
            query === "sdk_chats"
              ? "chats_v2"
              : query === "owner"
                ? "sessions_v2"
                : query === "authority"
                  ? "session_chat_catalogs"
                  : null;
          return catalogRows().filter((row) => row.table === table);
        },
      };
    },
  };
  const view = await agentHostSessionReader.read(input);
  assert.equal(queries.filter((query) => query === "sdk_chats").length, 1);
  assert.equal(view.sessions.length, 1);
  assert.equal(
    view.events.filter((event) => event.kind === "message").length,
    1,
  );
  assert.equal(
    view.events.filter((event) => event.kind === "tool-call").length,
    1,
  );
  assert.equal(
    new Set(view.events.map((event) => event.id)).size,
    view.events.length,
  );
  assert.ok(
    view.events.every((event) => event.sessionId === view.sessions[0]?.id),
  );
  assert.equal(view.sources[0]?.coverage.messages.status, "partial");
  assert.equal(view.sources[0]?.coverage.tools.status, "partial");
  assert.equal(view.sources[2]?.coverage.tokens.status, "unavailable");
});

test("directory discovery is bounded, excludes child links, rejects traversal and reports permission failures", async (t) => {
  const root = await temporary(t);
  const inside = path.join(root, "approved");
  await mkdir(inside);
  await writeFile(path.join(inside, "events.jsonl"), "");
  const access = await SourceAccess.create([inside]);
  if (process.platform !== "win32") {
    await symlink(root, path.join(inside, "outside"));
    assert.deepEqual(await access.entries("source-1", "", signal), [
      { name: "events.jsonl", kind: "file" },
    ]);
  }
  await assert.rejects(access.entries("source-1", "..", signal), {
    code: "SOURCE_SCOPE",
  });
  await assert.rejects(access.entries("unknown", "", signal), {
    code: "SOURCE_SCOPE",
  });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(access.entries("source-1", "", aborted.signal), {
    code: "READ_CANCELLED",
  });
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await chmod(inside, 0);
    try {
      await assert.rejects(access.entries("source-1", "", signal), {
        code: "SOURCE_DENIED",
      });
    } finally {
      await chmod(inside, 0o700);
    }
  }
  for (let index = 0; index < 256; index++)
    await writeFile(path.join(inside, `entry-${index}`), "");
  await assert.rejects(access.entries("source-1", "", signal), {
    code: "DISCOVERY_LIMIT",
  });
});

test("production discovery keeps the helper gate and never turns inaccessible selections into empty success", async (t) => {
  const root = await temporary(t);
  const service = new RuntimeService(
    await SourceAccess.create([root]),
    {
      sources: [root],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: null,
    },
    [],
    30000,
    null,
    productionMultiSourceReaders,
  );
  t.after(() => service.close());
  const result = discoveryResultSchema.parse(
    await service.discover(
      {
        roots: [
          {
            sourceId: "source-1",
            relativePath: "never-opened.db",
            layout: "catalog",
          },
        ],
      },
      signal,
    ),
  );
  assert.equal(result.sessions.length, 0);
  assert.equal(result.issues[0]?.code, "READER_UNAVAILABLE");
  assert.match(result.issues[0]?.message ?? "", /native-helper-v0.1.0/);
  assert.deepEqual(await readdir(root), []);
  assert.equal(service.view, null);
});

test("superseded discovery cannot publish after delayed cleanup, and replacement waits for ownership", async (t) => {
  const root = await temporary(t);
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let disposals = 0;
  t.mock.method(SourceDiscovery.prototype, "dispose", async () => {
    if (++disposals === 1) {
      assert.ok(markEntered);
      markEntered();
      await gate;
    }
  });
  const service = new RuntimeService(
    await SourceAccess.create([root]),
    {
      sources: [root],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: null,
    },
    [],
    30000,
    null,
    productionMultiSourceReaders,
  );
  t.after(() => service.close());
  const selection: DiscoveryRequest = {
    roots: [{ sourceId: "source-1", relativePath: "", layout: "settings" }],
  };
  const first = service.discover(selection, signal);
  const rejected = assert.rejects(first, { code: "READ_CANCELLED" });
  await entered;
  let published = false;
  const replacement = service.discover(selection, signal).then((value) => {
    published = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(published, false);
  assert.ok(release);
  release();
  await rejected;
  assert.equal((await replacement).issues[0]?.code, "READER_UNAVAILABLE");
  assert.equal(service.view, null);
});

test("empty, Local-exporter and unsupported histories stay unqualified; no roots are inferred", async (t) => {
  const root = await temporary(t);
  await mkdir(path.join(root, "native"));
  for (const [name, content] of [
    ["empty", ""],
    ["local", '{"traceId":"not-native","timestamp":"2026-11-03T10:00:00Z"}\n'],
    [
      "standalone-version",
      JSON.stringify({
        ...records()[0],
        data: { ...records()[0]?.data, copilotVersion: "other-runtime" },
      }),
    ],
  ] as const) {
    await mkdir(path.join(root, "native", name));
    await writeFile(path.join(root, "native", name, "events.jsonl"), content);
  }
  const discovery = new SourceDiscovery(
    await SourceAccess.create([root]),
    testNativeHelper,
    "probe",
    signal,
  );
  t.after(() => discovery.dispose());
  const result = await discovery.run({
    roots: [
      { sourceId: "source-1", relativePath: "native", layout: "history" },
    ],
  });
  assert.equal(result.sessions.length, 0);
  assert.equal(
    result.issues.filter((issue) => issue.code === "UNQUALIFIED_HISTORY")
      .length,
    3,
  );
  assert.ok(result.issues.some((issue) => issue.code === "CATALOG_REQUIRED"));
  assert.equal(discoveryRequestSchema.safeParse({ roots: [] }).success, false);
  assert.equal(
    discoveryRequestSchema.safeParse({
      roots: [{ sourceId: "source-1", relativePath: "", layout: "scan-home" }],
    }).success,
    false,
  );
});

/** Create source-owned WAL inputs and preserve their live writer sidecars until service cleanup completes. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-insights-discovery-native-"),
  );
  const catalogPath = path.join(root, "User", "globalStorage", "agent-host.db");
  const historyPath = path.join(
    root,
    "native",
    "directory-is-not-the-session-id",
    "events.jsonl",
  );
  const overlayPath = path.join(
    root,
    "agentSessionData",
    "unrelated-storage-key",
    "session.db",
  );
  for (const file of [catalogPath, historyPath, overlayPath])
    await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.join(root, "User", "profiles"));
  const catalog = new DatabaseSync(catalogPath);
  const overlay = new DatabaseSync(overlayPath);
  const writers = [catalog, overlay];
  catalog.exec(`
    PRAGMA journal_mode=WAL; PRAGMA user_version=22;
    CREATE TABLE chats_v2(chat_uri TEXT PRIMARY KEY NOT NULL, owner_session_uri TEXT, storage_resource TEXT, parent_chat TEXT, provider_data TEXT, tombstoned, archived, origin_session_uri TEXT);
    CREATE TABLE sessions_v2(session_uri TEXT PRIMARY KEY NOT NULL, provider TEXT, session_generation TEXT, verified, is_chat_backing);
    CREATE TABLE session_chat_catalogs(session_uri TEXT PRIMARY KEY NOT NULL, authority_version, session_generation TEXT, revision, projected_revision);
    CREATE TABLE metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT);
  `);
  for (const row of catalogRows()) {
    const names = Object.keys(row.values);
    catalog
      .prepare(
        `INSERT INTO ${row.table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      )
      .run(...Object.values(row.values));
  }
  overlay.exec(`
    PRAGMA journal_mode=WAL; PRAGMA user_version=18;
    CREATE TABLE turns(id TEXT PRIMARY KEY NOT NULL, event_id TEXT);
    CREATE TABLE turn_usage(turn_id TEXT PRIMARY KEY NOT NULL, usage TEXT NOT NULL);
    CREATE TABLE session_metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT);
    INSERT INTO session_metadata VALUES('agentHost.rowOwnerChat', 'copilotcli:/host/chat');
    INSERT INTO turns VALUES('turn', 'user');
  `);
  overlay.prepare("INSERT INTO turn_usage VALUES(?,?)").run(
    "turn",
    JSON.stringify({
      _meta: {
        turnTokenTotals: [
          {
            model: "synthetic",
            inputTokens: 7,
            cachedTokens: 0,
            outputTokens: 3,
          },
        ],
      },
    }),
  );
  await writeFile(
    historyPath,
    records()
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  const config = {
    sources: [root, root],
    port: 0,
    harness: "copilot" as const,
    model: null,
    copilotPath: path.join(root, "no-model"),
  };
  const service = new RuntimeService(
    await SourceAccess.create(config.sources),
    config,
    [],
    30000,
    null,
    [agentHostSessionReader],
    testNativeHelper,
  );
  t.after(async () => {
    await service.close();
    for (const writer of writers) writer.close();
    await rm(root, { recursive: true, force: true });
  });
  const selection: DiscoveryRequest = {
    roots: [
      { sourceId: "source-1", relativePath: "User", layout: "settings" },
      { sourceId: "source-1", relativePath: "native", layout: "history" },
      {
        sourceId: "source-1",
        relativePath: "agentSessionData",
        layout: "overlay",
      },
    ],
  };
  return {
    writers,
    root,
    config,
    catalog,
    overlay,
    catalogPath,
    historyPath,
    service,
    selection,
  };
}

test(
  "native discovery correlates by authoritative IDs, deduplicates aliases and opens both readers without source writes",
  native,
  async (t) => {
    const data = await fixture(t);
    const files = (await readdir(data.root, { recursive: true })).sort();
    const immutable = files.filter(
      (file) =>
        !file.endsWith("-shm") &&
        (file.endsWith(".db") ||
          file.endsWith("-wal") ||
          file.endsWith(".jsonl")),
    );
    const before = await Promise.all(
      immutable.map((file) => readFile(path.join(data.root, file))),
    );
    const result = await data.service.discover(
      {
        roots: [
          ...data.selection.roots,
          {
            sourceId: "source-2",
            relativePath: "User/globalStorage/agent-host.db",
            layout: "catalog",
          },
          { sourceId: "source-2", relativePath: "native", layout: "history" },
        ],
      },
      signal,
    );
    assert.deepEqual(result.issues, []);
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.runtime, "copilot-agent-host");
    assert.equal(session.state, "ready");
    assert.equal(session.mode, null);
    assert.equal(session.executionLocation, "unknown");
    assert.ok(
      session.references.some(
        (reference) => reference.location.kind === "sqlite",
      ),
    );
    assert.ok(
      session.references.some(
        (reference) => reference.location.kind === "jsonl",
      ),
    );
    assert.ok(session.selection);
    const view = await data.service.readSet(session.selection, signal);
    assert.equal(view.sessions.length, 1);
    assert.equal(
      view.events.filter((event) => event.kind === "message").length,
      1,
    );
    assert.equal(
      view.events.filter((event) => event.kind === "tool-call").length,
      1,
    );
    assert.equal(
      view.events.filter((event) => event.kind === "usage-observation").length,
      1,
    );
    assert.equal(view.sources.length, 3);
    assert.deepEqual(
      (await readdir(data.root, { recursive: true })).sort(),
      files,
    );
    assert.deepEqual(
      await Promise.all(
        immutable.map((file) => readFile(path.join(data.root, file))),
      ),
      before,
    );
  },
);

test(
  "native refresh exposes duplicate histories, rotation, deleted ownership and unselected overlays without archives",
  native,
  async (t) => {
    const data = await fixture(t);
    const first = await data.service.discover(data.selection, signal);
    assert.ok(first.sessions[0]?.selection);
    await data.service.readSet(first.sessions[0].selection, signal);
    const duplicate = path.join(data.root, "native", "copy");
    await mkdir(duplicate);
    await writeFile(
      path.join(duplicate, "events.jsonl"),
      await readFile(data.historyPath),
    );
    const ambiguous = await data.service.discover(data.selection, signal);
    assert.equal(data.service.view, null);
    assert.equal(ambiguous.sessions[0]?.state, "ambiguous");
    assert.equal(ambiguous.sessions[0]?.selection, null);
    await rm(path.join(duplicate, "events.jsonl"));
    await rm(data.historyPath);
    await assert.rejects(
      data.service.readSet(first.sessions[0].selection, signal),
      { code: "SOURCE_MISSING" },
    );
    const removed = await data.service.discover(data.selection, signal);
    assert.equal(removed.sessions[0]?.state, "unavailable");
    assert.match(removed.sessions[0]?.reason ?? "", /missing or rotated/);
    await writeFile(
      data.historyPath,
      records()
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const noOverlay = await data.service.discover(
      {
        roots: data.selection.roots.filter((root) => root.layout !== "overlay"),
      },
      signal,
    );
    assert.equal(noOverlay.sessions[0]?.selection?.sources.length, 2);
    assert.ok(noOverlay.sessions[0]?.selection);
    const view = await data.service.readSet(
      noOverlay.sessions[0].selection,
      signal,
    );
    assert.equal(
      view.events.filter((event) => event.kind === "message").length,
      1,
    );
    assert.equal(
      view.events.filter((event) => event.kind === "usage-observation").length,
      0,
    );
    assert.equal(view.sources[2]?.format, null);
    assert.ok(view.issues.some((issue) => issue.code === "unreadable-source"));
    data.catalog.exec("UPDATE chats_v2 SET tombstoned=1");
    const deleted = await data.service.discover(data.selection, signal);
    assert.equal(deleted.sessions[0]?.state, "ambiguous");
    assert.equal(deleted.sessions[0]?.runtime, "unknown");
    assert.equal(deleted.sessions[0]?.selection, null);
  },
);

test(
  "native discovery supports explicit profile catalogs, refuses competing profiles and preserves HTTP authorization",
  native,
  async (t) => {
    const data = await fixture(t);
    const profile = path.join(
      data.root,
      "User",
      "profiles",
      "custom",
      "globalStorage",
    );
    await mkdir(profile, { recursive: true });
    data.catalog.exec("PRAGMA wal_checkpoint(FULL)");
    await writeFile(
      path.join(profile, "agent-host.db"),
      await readFile(data.catalogPath),
    );
    const profileWriter = new DatabaseSync(path.join(profile, "agent-host.db"));
    data.writers.push(profileWriter);
    profileWriter.exec(
      "PRAGMA journal_mode=WAL; UPDATE chats_v2 SET archived=archived",
    );
    const competing = await data.service.discover(data.selection, signal);
    assert.equal(competing.sessions.length, 2);
    assert.ok(
      competing.sessions.every(
        (session) =>
          session.state === "ambiguous" && session.selection === null,
      ),
    );
    const exact: DiscoveryRequest = {
      roots: [
        ...data.selection.roots.filter((root) => root.layout !== "settings"),
        {
          sourceId: "source-1",
          relativePath: "User/globalStorage/agent-host.db",
          layout: "catalog",
        },
      ],
    };
    const selected = await data.service.discover(exact, signal);
    assert.equal(selected.sessions.length, 1);
    assert.equal(selected.sessions[0]?.state, "ready");
    const runtime = await startRuntime(data.config, {
      multiSourceReaders: [agentHostSessionReader],
      nativeHelper: testNativeHelper,
      analysisProvider: syntheticProvider,
    });
    t.after(() => runtime.close());
    const unauthenticated = await fetch(runtime.origin + "/api/discover", {
      method: "POST",
      headers: { Origin: runtime.origin, "Content-Type": "application/json" },
      body: JSON.stringify(exact),
    });
    assert.equal(unauthenticated.status, 401);
    const response = await fetch(runtime.origin + "/api/discover", {
      method: "POST",
      headers: {
        Origin: runtime.origin,
        "Content-Type": "application/json",
        "X-Agent-Insights-Token": runtime.token,
      },
      body: JSON.stringify(exact),
    });
    assert.equal(response.status, 200);
    assert.equal(
      discoveryResultSchema.parse(await response.json()).sessions[0]?.state,
      "ready",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
  },
);
