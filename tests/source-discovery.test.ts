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
  rmdir,
  symlink,
  chmod,
  link,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SourceAccess } from "../src/runtime/sources.js";
import { SourceDiscovery } from "../src/runtime/discovery.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { RuntimeService } from "../src/runtime/service.js";
import { startRuntime } from "../src/runtime/server.js";
import {
  discoveryRequestSchema,
  discoveryResultSchema,
  MAX_CONTROL_BODY_BYTES,
  type DiscoveryRequest,
} from "../src/runtime/protocol.js";
import { agentHostSessionReader } from "../src/evidence/readers/agent-host-session.js";
import { prepareAgentHostDiscoveryCatalog } from "../src/evidence/readers/agent-host-catalog.js";
import { productionMultiSourceReaders } from "../src/evidence/readers/index.js";
import type {
  MultiSourceInput,
  SqliteRow,
  SqliteInput,
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

test("discovery preserves first JSON members, original witnesses and native validation for unsupported values", async () => {
  const chats = catalogRows()
    .filter((row) => row.table === "chats_v2")
    .map((row) => ({
      ...row,
      values: {
        ...row.values,
        provider_data:
          '{"sdkSessionId":"other","sdkSessionId":"sdk-fictional"}',
      },
    }));
  const metadata: SqliteRow = {
    table: "metadata",
    key: [
      { column: "key", type: "text", value: "sessionStorageIdentity:runtime" },
    ],
    fingerprint: "b".repeat(64),
    values: {
      key: "sessionStorageIdentity:runtime",
      value: '{"storage":"other","storage":"copilotcli:/host"}',
    },
  };
  const calls: string[] = [];
  const catalog: SqliteInput = {
    available: true,
    kind: "sqlite",
    sourceId: "catalog",
    userVersion: 22,
    snapshotScope: "connection",
    async query(id) {
      calls.push(id);
      return id === "discovery_metadata" ? [metadata] : [];
    },
  };
  const prepared = await prepareAgentHostDiscoveryCatalog(
    catalog,
    chats,
    signal,
  );
  assert.deepEqual(
    await prepared.query("sdk_chats", { sdk: "sdk-fictional" }),
    [],
  );
  assert.deepEqual(
    await prepared.query("storage_identity", {
      prefix: "sessionStorageIdentity:",
      storage: "copilotcli:/host",
    }),
    [],
  );
  assert.deepEqual(
    await prepared.query("metadata_key", {
      key: "sessionStorageIdentity:runtime",
    }),
    [metadata],
  );
  assert.deepEqual(calls, ["discovery_metadata"]);
  await prepared.query("sdk_chats", { sdk: "\ud800" });
  let nested: unknown = null;
  for (let depth = 0; depth < 1001; depth++) nested = { nested };
  const deep = await prepareAgentHostDiscoveryCatalog(
    catalog,
    chats.map((row) => ({
      ...row,
      values: {
        ...row.values,
        provider_data: JSON.stringify({
          sdkSessionId: "sdk-fictional",
          nested,
        }),
      },
    })),
    signal,
  );
  assert.deepEqual(await deep.query("sdk_chats", { sdk: "sdk-fictional" }), []);
  assert.deepEqual(calls, [
    "discovery_metadata",
    "sdk_chats",
    "discovery_metadata",
  ]);
  for (const [id, bindings] of [
    ["sdk_chats", { sdk: "s".repeat(9000) }],
    ["metadata_key", { key: "k".repeat(9000) }],
    [
      "storage_identity",
      { prefix: "sessionStorageIdentity:", storage: "o".repeat(9000) },
    ],
  ] as const)
    await assert.rejects(prepared.query(id, bindings), {
      code: "SQLITE_LIMIT",
    });
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

for (const code of [
  "SQLITE_LIMIT",
  "SOURCE_TOO_LARGE",
  "SQLITE_CLEANUP_FAILED",
  "SQLITE_PROCESS_PROTOCOL",
  "SQLITE_GUARD",
  "NATIVE_GUARD_UNAVAILABLE",
]) {
  test(`discovery rejects ${code} instead of publishing an incomplete correlation set`, async (t) => {
    const root = await temporary(t);
    await writeFile(path.join(root, "catalog.db"), "");
    t.mock.method(SourceAccess.prototype, "database", async () => {
      throw new RuntimeError(code, "Synthetic source budget exceeded.", 413);
    });
    const discovery = new SourceDiscovery(
      await SourceAccess.create([root]),
      testNativeHelper,
      "limited",
      signal,
    );
    t.after(() => discovery.dispose());
    await assert.rejects(
      discovery.run({
        roots: [
          {
            sourceId: "source-1",
            relativePath: "catalog.db",
            layout: "catalog",
          },
        ],
      }),
      { code },
    );
  });
}

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
  "native settings discovery permits an absent profiles child but reports invalid selected roots and existing children",
  native,
  async (t) => {
    const data = await fixture(t);
    const profiles = path.join(data.root, "User", "profiles");
    await rmdir(profiles);
    const result = await data.service.discover(data.selection, signal);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]?.state, "ready");
    assert.deepEqual(result.issues, []);

    await writeFile(profiles, "not a directory");
    const invalidChild = await data.service.discover(data.selection, signal);
    assert.ok(
      invalidChild.issues.some((issue) => issue.code === "NOT_A_DIRECTORY"),
    );
    const missingRoot = await data.service.discover(
      {
        roots: [
          {
            sourceId: "source-1",
            relativePath: "missing-settings",
            layout: "settings",
          },
        ],
      },
      signal,
    );
    assert.equal(missingRoot.sessions.length, 0);
    assert.ok(
      missingRoot.issues.some(
        (issue) =>
          issue.relativePath === "missing-settings" &&
          issue.code === "SOURCE_MISSING",
      ),
    );
  },
);

test(
  "native catalogs sharing a main inode but different sidecars remain independent",
  native,
  async (t) => {
    const data = await fixture(t);
    const other = path.join(data.root, "Other", "agent-host.db");
    await mkdir(path.dirname(other));
    await link(data.catalogPath, other);
    for (const suffix of ["-wal", "-shm"])
      await copyFile(data.catalogPath + suffix, other + suffix);
    const result = await data.service.discover(
      {
        roots: [
          ...data.selection.roots.filter((root) => root.layout === "history"),
          {
            sourceId: "source-1",
            relativePath: path.relative(data.root, data.catalogPath),
            layout: "catalog",
          },
          {
            sourceId: "source-1",
            relativePath: path.relative(data.root, other),
            layout: "catalog",
          },
        ],
      },
      signal,
    );
    const catalogs = [
      path.relative(data.root, data.catalogPath),
      path.relative(data.root, other),
    ];
    assert.deepEqual(
      [
        ...new Set([
          ...result.locators.map((locator) => locator.relativePath),
          ...result.issues.map((issue) => issue.relativePath),
        ]),
      ]
        .filter((location) => catalogs.includes(location))
        .sort(),
      catalogs.sort(),
    );
    const recovery = result.issues.filter(
      (issue) =>
        catalogs.includes(issue.relativePath) &&
        issue.code === "SQLITE_RECOVERY_REQUIRED",
    );
    assert.equal(
      result.sessions.length + recovery.length,
      2,
      JSON.stringify(result.issues),
    );
    assert.ok(
      result.sessions.every((session) =>
        result.sessions.length === 1
          ? session.state === "ready" && session.selection !== null
          : session.state === "ambiguous" && session.selection === null,
      ),
    );
  },
);

test(
  "native explicit roots use admitted path kinds instead of extensions",
  native,
  async (t) => {
    const data = await fixture(t);
    const directory = path.join(data.root, "history-root.jsonl");
    await mkdir(directory);
    await writeFile(
      path.join(directory, "events.jsonl"),
      await readFile(data.historyPath),
    );
    await writeFile(
      path.join(data.root, "extensionless-history"),
      await readFile(data.historyPath),
    );
    await symlink(
      path.join(data.root, "agentSessionData", "unrelated-storage-key"),
      path.join(data.root, "overlay-root.db"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const relativePath of [
      "history-root.jsonl",
      "extensionless-history",
    ]) {
      const result = await data.service.discover(
        {
          roots: [
            ...data.selection.roots.filter(
              (root) => root.layout === "settings",
            ),
            { sourceId: "source-1", relativePath, layout: "history" },
            {
              sourceId: "source-1",
              relativePath: "overlay-root.db",
              layout: "overlay",
            },
          ],
        },
        signal,
      );
      assert.equal(result.sessions[0]?.state, "ready");
      assert.equal(result.sessions[0]?.selection?.sources.length, 3);
      assert.ok(result.sessions[0]?.selection);
      assert.equal(
        (await data.service.readSet(result.sessions[0].selection, signal))
          .sessions.length,
        1,
      );
    }
  },
);

test(
  "native discovery accepts the exact reopen control byte limit and rejects one additional byte",
  native,
  async (t) => {
    const data = await fixture(t);
    const original = (await data.service.discover(data.selection, signal))
      .sessions[0]?.selection;
    assert.ok(original);
    const owner = original.expectedSession?.nativeIdentities.find(
      (identity) => identity.namespace === "agent-host-session",
    );
    assert.ok(owner);
    const runtime = "r".repeat(
      MAX_CONTROL_BODY_BYTES -
        Buffer.byteLength(JSON.stringify(original)) +
        owner.value.length,
    );
    data.catalog.prepare("INSERT INTO metadata VALUES(?,?)").run(
      `sessionStorageIdentity:${runtime}`,
      JSON.stringify({
        runtime,
        storage: owner.value,
        provider: "copilotcli",
      }),
    );
    const exact = (await data.service.discover(data.selection, signal))
      .sessions[0]?.selection;
    assert.ok(exact);
    assert.equal(
      Buffer.byteLength(JSON.stringify(exact)),
      MAX_CONTROL_BODY_BYTES,
    );
    assert.equal(
      (await data.service.readSet(exact, signal)).sessions.length,
      1,
    );
    const server = await startRuntime(data.config, {
      multiSourceReaders: [agentHostSessionReader],
      nativeHelper: testNativeHelper,
      analysisProvider: syntheticProvider,
    });
    t.after(() => server.close());
    for (const [body, status] of [
      [JSON.stringify(exact), 200],
      [`${JSON.stringify(exact)} `, 413],
    ] as const) {
      const response = await fetch(server.origin + "/api/read-set", {
        method: "POST",
        headers: {
          Origin: server.origin,
          "Content-Type": "application/json",
          "X-Agent-Insights-Token": server.token,
        },
        body,
      });
      assert.equal(response.status, status);
      await response.arrayBuffer();
    }
    data.catalog.prepare("UPDATE metadata SET key=?, value=? WHERE key=?").run(
      `sessionStorageIdentity:${runtime}r`,
      JSON.stringify({
        runtime: `${runtime}r`,
        storage: owner.value,
        provider: "copilotcli",
      }),
      `sessionStorageIdentity:${runtime}`,
    );
    await assert.rejects(data.service.discover(data.selection, signal), {
      code: "DISCOVERY_LIMIT",
    });
    assert.equal(data.service.view, null);
  },
);

test(
  "native discovery qualifies all 64 translated chats within shared budgets, preserves suppression and rejects row 65",
  native,
  async (t) => {
    const data = await fixture(t);
    data.catalog.exec(
      "DELETE FROM chats_v2; DELETE FROM sessions_v2; DELETE FROM session_chat_catalogs;",
    );
    const chat = data.catalog.prepare(
      "INSERT INTO chats_v2 VALUES(?,?,?,NULL,?,0,0,NULL)",
    );
    const owner = data.catalog.prepare(
      "INSERT INTO sessions_v2 VALUES(?,'copilotcli','g1',1,0)",
    );
    const authority = data.catalog.prepare(
      "INSERT INTO session_chat_catalogs VALUES(?,2,'g1',1,1)",
    );
    const metadata = data.catalog.prepare("INSERT INTO metadata VALUES(?,?)");
    for (let index = 0; index < 64; index++) {
      const sdk = index === 0 ? "sdk-fictional" : `sdk-${index}`;
      const storedOwner = `stored-owner-${index}`;
      const storedChat = `stored-chat-${index}`;
      chat.run(
        storedChat,
        storedOwner,
        `copilotcli:/${sdk}`,
        JSON.stringify({ sdkSessionId: sdk }),
      );
      owner.run(storedOwner);
      authority.run(storedOwner);
      metadata.run(
        `sessionStorageIdentity:runtime-owner-${index}`,
        JSON.stringify({
          runtime: `runtime-owner-${index}`,
          storage: storedOwner,
          provider: "copilotcli",
        }),
      );
      metadata.run(
        `chatStorageIdentity:runtime-chat-${index}`,
        JSON.stringify({
          runtime: `runtime-chat-${index}`,
          storage: storedChat,
        }),
      );
    }
    const selection = {
      roots: data.selection.roots.filter((root) => root.layout !== "overlay"),
    };
    const result = await data.service.discover(selection, signal);
    assert.equal(result.sessions.length, 64);
    assert.ok(
      result.sessions.every(
        (session) => session.runtime === "copilot-agent-host",
      ),
    );
    assert.equal(
      result.sessions.filter((session) => session.state === "ready").length,
      1,
    );
    assert.equal(
      result.sessions.filter((session) => session.state === "unavailable")
        .length,
      63,
    );
    const updateChat = data.catalog.prepare(
      "UPDATE chats_v2 SET provider_data=? WHERE chat_uri=?",
    );
    const updateMetadata = data.catalog.prepare(
      "UPDATE metadata SET value=? WHERE key=?",
    );
    for (let index = 0; index < 64; index++) {
      const sdk = index === 0 ? "sdk-fictional" : `sdk-${index}`;
      updateChat.run(
        `{
        "nested": {"sdkSessionId": "decoy"},
        "sdkSession\\u0049d": ${JSON.stringify(sdk)},
        "sdkSessionId": ${JSON.stringify(sdk)}
      }`,
        `stored-chat-${index}`,
      );
      updateMetadata.run(
        JSON.stringify(
          {
            runtime: `runtime-owner-${index}`,
            storage: `stored-owner-${index}`,
            provider: "copilotcli",
          },
          null,
          2,
        ).replace('"storage"', '"stor\\u0061ge"'),
        `sessionStorageIdentity:runtime-owner-${index}`,
      );
      updateMetadata.run(
        JSON.stringify(
          {
            runtime: `runtime-chat-${index}`,
            storage: `stored-chat-${index}`,
          },
          null,
          2,
        ).replace('"storage"', '"stor\\u0061ge"'),
        `chatStorageIdentity:runtime-chat-${index}`,
      );
    }
    const encoded = await data.service.discover(selection, signal);
    assert.equal(encoded.sessions.length, 64);
    assert.ok(
      encoded.sessions.every(
        (session) => session.runtime === "copilot-agent-host",
      ),
    );
    updateChat.run(
      Buffer.from('{"sdkSessionId":"unrelated-blob"}'),
      "stored-chat-63",
    );
    const blobChat = await data.service.discover(selection, signal);
    assert.equal(blobChat.sessions.length, 63);
    assert.ok(
      blobChat.sessions.every(
        (session) => session.runtime === "copilot-agent-host",
      ),
    );
    updateChat.run('{"sdkSessionId":"sdk-63"}', "stored-chat-63");
    metadata.run(
      "sessionStorageIdentity:unrelated-blob",
      Buffer.from(
        '{"runtime":"unrelated-blob","storage":"unrelated-owner","provider":"copilotcli"}',
      ),
    );
    metadata.run(
      "chatStorageIdentity:unrelated-blob",
      Buffer.from('{"runtime":"unrelated-blob","storage":"unrelated-chat"}'),
    );
    const blobMetadata = await data.service.discover(selection, signal);
    assert.equal(blobMetadata.sessions.length, 64);
    assert.ok(
      blobMetadata.sessions.every(
        (session) => session.runtime === "copilot-agent-host",
      ),
    );
    updateMetadata.run(
      Buffer.from(
        '{"runtime":"runtime-owner-63","storage":"stored-owner-63","provider":"copilotcli"}',
      ),
      "sessionStorageIdentity:runtime-owner-63",
    );
    const affectedBlob = await data.service.discover(selection, signal);
    assert.equal(affectedBlob.sessions.length, 64);
    assert.equal(
      affectedBlob.sessions.filter(
        (session) => session.runtime === "copilot-agent-host",
      ).length,
      63,
    );
    assert.equal(
      affectedBlob.sessions.find((session) => session.sdkSessionId === "sdk-63")
        ?.runtime,
      "unknown",
    );
    updateMetadata.run(
      '{"runtime":"runtime-owner-63","storage":"stored-owner-63","provider":"copilotcli"}',
      "sessionStorageIdentity:runtime-owner-63",
    );
    data.catalog.exec(`UPDATE chats_v2 SET storage_resource=NULL,
      provider_data='{"sdkSessionId":"sdk-fictional","sdkSessionId":"different"}'
      WHERE chat_uri='stored-chat-0'`);
    const firstMismatch = (
      await data.service.discover(selection, signal)
    ).sessions.find((session) => session.sdkSessionId === "different");
    assert.equal(firstMismatch?.runtime, "unknown");
    assert.equal(firstMismatch?.selection, null);
    data.catalog.exec(`UPDATE chats_v2 SET storage_resource=NULL,
      provider_data='{"sdkSessionId":"different","sdkSessionId":"sdk-fictional"}'
      WHERE chat_uri='stored-chat-0'`);
    const duplicate = (
      await data.service.discover(selection, signal)
    ).sessions.find((session) => session.sdkSessionId === "sdk-fictional");
    assert.equal(duplicate?.runtime, "unknown");
    assert.equal(duplicate?.selection, null);
    data.catalog
      .exec(`UPDATE chats_v2 SET storage_resource='copilotcli:/sdk-fictional',
      provider_data='{"sdkSessionId":"sdk-fictional"}' WHERE chat_uri='stored-chat-0'`);
    metadata.run("sessionHidden:runtime-owner-63", "false");
    const hidden = (
      await data.service.discover(selection, signal)
    ).sessions.find((session) => session.sdkSessionId === "sdk-63");
    assert.equal(hidden?.state, "ambiguous");
    assert.match(hidden?.reason ?? "", /hidden/);
    assert.ok(
      hidden?.references.some(
        (reference) =>
          reference.location.kind === "sqlite" &&
          reference.location.key.some(
            (part) => part.value === "sessionHidden:runtime-owner-63",
          ),
      ),
    );
    metadata.run(
      `sessionStorageIdentity:${"r".repeat(9000)}`,
      JSON.stringify({
        runtime: "r".repeat(9000),
        storage: "stored-owner-0",
        provider: "copilotcli",
      }),
    );
    data.catalog.exec(
      "DELETE FROM metadata WHERE key='sessionStorageIdentity:runtime-owner-0'",
    );
    await assert.rejects(data.service.discover(selection, signal), {
      code: "SQLITE_LIMIT",
    });
    data.catalog
      .prepare("DELETE FROM metadata WHERE key=?")
      .run(`sessionStorageIdentity:${"r".repeat(9000)}`);
    chat.run(
      "row-65",
      "owner-65",
      "copilotcli:/sdk-65",
      '{"sdkSessionId":"sdk-65"}',
    );
    await assert.rejects(data.service.discover(selection, signal), {
      code: "DISCOVERY_LIMIT",
    });
  },
);

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
    assert.ok(
      session.references.every((reference) =>
        result.locators.some(
          (locator) => locator.evidenceSourceId === reference.sourceId,
        ),
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
  "native discovered opens reject replacement SDK histories and reassigned host chats at unchanged paths",
  native,
  async (t) => {
    const data = await fixture(t);
    const selected = (await data.service.discover(data.selection, signal))
      .sessions[0]?.selection;
    assert.ok(selected?.expectedSession);
    data.catalog
      .prepare(
        "INSERT INTO chats_v2 SELECT 'copilotcli:/host/other', owner_session_uri, 'copilotcli:/sdk-other', NULL, ?, 0, 0, NULL FROM chats_v2",
      )
      .run('{"sdkSessionId":"sdk-other"}');
    await writeFile(
      data.historyPath,
      records("sdk-other")
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    await assert.rejects(data.service.readSet(selected, signal), {
      code: "SOURCE_CHANGED",
    });
    assert.equal(data.service.view, null);
    await writeFile(
      data.historyPath,
      records()
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    data.catalog.exec(
      "UPDATE chats_v2 SET chat_uri='copilotcli:/host/reassigned' WHERE chat_uri='copilotcli:/host/chat'",
    );
    await assert.rejects(data.service.readSet(selected, signal), {
      code: "SOURCE_CHANGED",
    });
    assert.equal(data.service.view, null);
  },
);

test(
  "native discovery reports overlays whose retained owner matches no selected chat",
  native,
  async (t) => {
    const data = await fixture(t);
    data.overlay.exec(
      "UPDATE session_metadata SET value='copilotcli:/unassigned/chat' WHERE key='agentHost.rowOwnerChat'",
    );
    const result = await data.service.discover(data.selection, signal);
    assert.equal(result.sessions[0]?.state, "ready");
    assert.equal(result.sessions[0]?.selection?.sources.length, 2);
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.code === "OVERLAY_UNASSIGNED" &&
          issue.sourceId === "source-1" &&
          issue.relativePath.endsWith(
            path.join("unrelated-storage-key", "session.db"),
          ),
      ),
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
    const overlayBinding = first.sessions[0].selection.sources.find(
      (binding) => binding.key === "overlay",
    );
    assert.ok(overlayBinding);
    data.overlay.close();
    data.writers.splice(data.writers.indexOf(data.overlay), 1);
    await rm(path.join(data.root, overlayBinding.relativePath));
    const missingOverlay = await data.service.readSet(
      first.sessions[0].selection,
      signal,
    );
    assert.equal(
      missingOverlay.events.filter((event) => event.kind === "message").length,
      1,
    );
    assert.equal(
      missingOverlay.events.filter(
        (event) => event.kind === "usage-observation",
      ).length,
      0,
    );
    assert.ok(
      missingOverlay.issues.some((issue) => issue.code === "unreadable-source"),
    );
    const overlayDirectory = path.dirname(
      path.join(data.root, overlayBinding.relativePath),
    );
    const linkedOverlay = path.join(data.root, "outside-selected-overlay");
    await mkdir(linkedOverlay);
    await writeFile(path.join(linkedOverlay, "session.db"), "synthetic");
    await rm(overlayDirectory, { recursive: true });
    await symlink(
      linkedOverlay,
      overlayDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      data.service.readSet(first.sessions[0].selection, signal),
      { code: "SOURCE_LINK" },
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
    assert.ok(
      competing.sessions.every((session) =>
        session.references.every((reference) =>
          competing.locators.some(
            (locator) => locator.evidenceSourceId === reference.sourceId,
          ),
        ),
      ),
    );
    assert.equal(
      new Set(
        competing.locators
          .filter((locator) => locator.relativePath.endsWith("agent-host.db"))
          .map((locator) => locator.relativePath),
      ).size,
      2,
    );
    profileWriter
      .prepare("UPDATE chats_v2 SET provider_data=?, storage_resource=?")
      .run('{"sdkSessionId":"sdk-other"}', "copilotcli:/sdk-other");
    const otherHistory = path.join(data.root, "native", "other");
    await mkdir(otherHistory);
    await writeFile(
      path.join(otherHistory, "events.jsonl"),
      records("sdk-other")
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const sameChat = await data.service.discover(data.selection, signal);
    assert.equal(sameChat.sessions.length, 2);
    assert.ok(
      sameChat.sessions.every(
        (session) =>
          session.state === "ambiguous" && session.selection === null,
      ),
    );
    profileWriter.exec(
      "UPDATE chats_v2 SET chat_uri='copilotcli:/host/other-chat'",
    );
    const sharedParent = await data.service.discover(data.selection, signal);
    assert.equal(sharedParent.sessions.length, 2);
    assert.ok(
      sharedParent.sessions.every((session) => session.state === "ready"),
    );
    assert.equal(
      sharedParent.sessions
        .find((session) => session.sdkSessionId === "sdk-other")
        ?.selection?.sources.some((source) => source.key === "overlay"),
      false,
    );
    profileWriter.prepare("INSERT INTO metadata VALUES(?,?)").run(
      "chatStorageIdentity:copilotcli:/host/chat",
      JSON.stringify({
        runtime: "copilotcli:/host/chat",
        storage: "copilotcli:/host/other-chat",
      }),
    );
    const translatedCollision = await data.service.discover(
      data.selection,
      signal,
    );
    assert.equal(translatedCollision.sessions.length, 2);
    assert.ok(
      translatedCollision.sessions.every(
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

test(
  "native discovery retains JSON-BLOB competitors and rejects BLOB-backed storage mappings",
  native,
  async (t) => {
    const data = await fixture(t);
    data.catalog
      .prepare(
        `INSERT INTO chats_v2 SELECT 'competing-chat', owner_session_uri,
    NULL, NULL, ?, 0, 0, NULL FROM chats_v2`,
      )
      .run(Buffer.from('{"sdkSessionId":"sdk-fictional"}'));
    const competing = await data.service.discover(data.selection, signal);
    assert.equal(competing.sessions[0]?.runtime, "unknown");
    assert.equal(competing.sessions[0]?.selection, null);
    data.catalog
      .prepare(
        "UPDATE chats_v2 SET provider_data=? WHERE chat_uri='competing-chat'",
      )
      .run(
        Buffer.concat([
          Buffer.from('{"sdkSessionId":"sdk-fictional","other":"'),
          Buffer.from([255]),
          Buffer.from('"}'),
        ]),
      );
    const nonUtf8Blob = await data.service.discover(data.selection, signal);
    assert.equal(nonUtf8Blob.sessions[0]?.runtime, "unknown");
    assert.equal(nonUtf8Blob.sessions[0]?.selection, null);
    data.catalog
      .prepare(
        "UPDATE chats_v2 SET provider_data=? WHERE chat_uri='competing-chat'",
      )
      .run(Buffer.from('{"sdkSessionId":"sdk-fictional"}\0trailing'));
    const nulBlob = await data.service.discover(data.selection, signal);
    assert.equal(nulBlob.sessions[0]?.runtime, "unknown");
    assert.equal(nulBlob.sessions[0]?.selection, null);
    data.catalog
      .prepare(
        "UPDATE chats_v2 SET provider_data=? WHERE chat_uri='competing-chat'",
      )
      .run('{"sdkSessionId":"sdk-fictional"}\0trailing');
    const nulText = await data.service.discover(data.selection, signal);
    assert.equal(nulText.sessions[0]?.runtime, "unknown");
    assert.equal(nulText.sessions[0]?.selection, null);
    data.catalog.exec("DELETE FROM chats_v2 WHERE chat_uri='competing-chat'");
    data.catalog
      .prepare("INSERT INTO metadata VALUES(?,?)")
      .run(
        "sessionStorageIdentity:blob-runtime",
        Buffer.from(
          '{"runtime":"blob-runtime","storage":"copilotcli:/host","provider":"copilotcli"}',
        ),
      );
    const malformed = await data.service.discover(data.selection, signal);
    assert.equal(malformed.sessions[0]?.runtime, "unknown");
    assert.equal(malformed.sessions[0]?.selection, null);
    assert.match(malformed.sessions[0]?.reason ?? "", /malformed/);
  },
);

test(
  "native generated paths reject leaf/intermediate links and stale opens but allow explicitly selected aliases",
  native,
  async (t) => {
    const data = await fixture(t);
    const original = (await data.service.discover(data.selection, signal))
      .sessions[0]?.selection;
    assert.ok(original);
    const outside = path.join(data.root, "outside-selected-native");
    await mkdir(outside);
    await writeFile(
      path.join(outside, "events.jsonl"),
      await readFile(data.historyPath),
    );
    let explicitHistory: string;
    if (process.platform === "win32") {
      await rm(path.dirname(data.historyPath), { recursive: true });
      await symlink(outside, path.dirname(data.historyPath), "junction");
      explicitHistory = path.relative(
        data.root,
        path.dirname(data.historyPath),
      );
    } else {
      await rm(data.historyPath);
      await symlink(path.join(outside, "events.jsonl"), data.historyPath);
      explicitHistory = path.relative(data.root, data.historyPath);
    }
    await assert.rejects(data.service.readSet(original, signal), {
      code: "SOURCE_LINK",
    });
    assert.equal(data.service.view, null);
    const generated = await data.service.discover(data.selection, signal);
    assert.equal(generated.sessions[0]?.state, "unavailable");
    const explicit = await data.service.discover(
      {
        roots: [
          ...data.selection.roots.filter((root) => root.layout !== "history"),
          {
            sourceId: "source-1",
            relativePath: explicitHistory,
            layout: "history",
          },
        ],
      },
      signal,
    );
    assert.ok(explicit.sessions[0]?.selection);
    assert.equal(
      (await data.service.readSet(explicit.sessions[0].selection, signal))
        .sessions.length,
      1,
    );
    const linkedUser = path.join(data.root, "LinkedUser");
    await mkdir(path.join(linkedUser, "profiles"), { recursive: true });
    await symlink(
      path.dirname(data.catalogPath),
      path.join(linkedUser, "globalStorage"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const settings = await data.service.discover(
      {
        roots: [
          {
            sourceId: "source-1",
            relativePath: "LinkedUser",
            layout: "settings",
          },
          {
            sourceId: "source-1",
            relativePath: explicitHistory,
            layout: "history",
          },
        ],
      },
      signal,
    );
    assert.equal(settings.sessions.length, 0);
    assert.ok(settings.issues.some((issue) => issue.code === "SOURCE_LINK"));
  },
);
