/**
 * Independently authored native events/catalog rows, never private captures or
 * producer SDK restoration. Native integration additionally uses owned temporary
 * databases and an explicitly prepared guard, and runs on all hosted native targets.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentHostConversationReader } from "../src/evidence/readers/agent-host-conversation.js";
import { productionMultiSourceReaders } from "../src/evidence/readers/index.js";
import type { MultiSourceInput, SqliteRow } from "../src/evidence/source-access.js";
import { RuntimeService } from "../src/runtime/service.js";
import { SourceAccess } from "../src/runtime/sources.js";
import { testNativeHelper } from "./fixtures/native-helper.js";

/** Synthetic envelope overrides allow damage/omission cases without weakening production types. */
function event(type: string, id: string, data: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  return { id, type, data, parentId: "start", timestamp: "2026-11-03T10:00:00.001Z", ...fields };
}

/** Match only the qualified schema/runtime, using fictional identities and no real messages. */
function start() {
  return event("session.start", "start", {
    sessionId: "sdk-fictional",
    version: 1,
    producer: "copilot-agent",
    copilotVersion: "1.0.103-unstable.r41379698026.g3219c66",
    detachedFromSpawningParentSessionId: "sdk-parent",
  }, { parentId: null });
}

/** Construct original-row-shaped witnesses for unit tests; real runtime integration verifies actual fingerprints. */
function row(table: string, values: SqliteRow["values"]): SqliteRow {
  const column = table === "chats_v2" ? "chat_uri" : table === "metadata" ? "key" : "session_uri";
  return {
    table, values,
    key: [{ column, type: "text", value: String(values[column]) }],
    fingerprint: createHash("sha256").update(JSON.stringify(values, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)).digest("hex"),
  };
}

/** Minimal normalized schema-22 ownership, including explicit runtime/storage translations. */
function catalogRows(): Record<string, SqliteRow[]> {
  return {
    session_backed_chats: [],
    sdk_chats: [row("chats_v2", {
      chat_uri: "copilotcli:/stored/chat",
      owner_session_uri: "copilotcli:/stored",
      storage_resource: "copilotcli:/original/chat",
      parent_chat: "ahp-chat:/parent",
      provider_data: '{"sdkSessionId":"sdk-fictional"}',
      tombstoned: 0n, archived: 1n, origin_session_uri: "copilotcli:/origin",
    })],
    owner: [row("sessions_v2", {
      session_uri: "copilotcli:/stored", provider: "copilotcli",
      session_generation: "generation-fictional", verified: 1n, is_chat_backing: 0n,
    })],
    authority: [row("session_chat_catalogs", {
      session_uri: "copilotcli:/stored", authority_version: 2n,
      session_generation: "generation-fictional", revision: 3n, projected_revision: 3n,
    })],
    identity_metadata: [
      row("metadata", { key: "sessionStorageIdentity:ahp-session:/runtime", value: '{"runtime":"ahp-session:/runtime","storage":"copilotcli:/stored","provider":"copilotcli"}' }),
      row("metadata", { key: "chatStorageIdentity:ahp-chat:/runtime", value: '{"runtime":"ahp-chat:/runtime","storage":"copilotcli:/stored/chat"}' }),
    ],
  };
}

/** Borrow synthetic bytes in small, UTF-8-splitting pieces; query bindings must be code-owned exact lookups. */
function input(
  records: readonly unknown[],
  options: {
    rows?: Record<string, SqliteRow[]>;
    raw?: string;
    readId?: string;
    catalogMissing?: boolean;
    historyMissing?: boolean;
    signal?: AbortSignal;
    userVersion?: number;
  } = {},
): MultiSourceInput {
  const readId = options.readId ?? "test-read";
  const rows = options.rows ?? catalogRows();
  const bytes = Buffer.from(options.raw ?? records.map((value) => JSON.stringify(value)).join("\n") + "\n");
  return {
    readId,
    signal: options.signal ?? new AbortController().signal,
    get(key) {
      const sourceId = `${readId}:source:${key}`;
      if ((key === "catalog" && options.catalogMissing) || (key === "history" && options.historyMissing))
        return { available: false, sourceId, code: "SOURCE_MISSING", reason: "Synthetic absent input." };
      if (key === "history")
        return {
          available: true, kind: "file", sourceId,
          bytes: {
            async *[Symbol.asyncIterator]() {
              for (let offset = 0; offset < bytes.length; offset += 7)
                yield bytes.subarray(offset, offset + 7);
            },
          },
        };
      if (key !== "catalog") throw new Error("Undeclared input role.");
      return {
        available: true, kind: "sqlite", sourceId,
        userVersion: options.userVersion ?? 22, snapshotScope: "connection",
        query(queryId, bindings) {
          if (queryId === "sdk_chats") assert.deepEqual(bindings, { sdk: "sdk-fictional" });
          else if (queryId === "session_backed_chats") assert.deepEqual(bindings, { storage: "copilotcli:/sdk-fictional" });
          else if (queryId === "owner" || queryId === "authority")
            assert.deepEqual(bindings, { owner: "copilotcli:/stored" });
          else {
            assert.ok(queryId === "storage_identity" || queryId === "metadata_key");
            return Promise.resolve((rows.identity_metadata ?? []).filter((item) => {
              if (queryId === "metadata_key") return item.values.key === bindings.key;
              let value: unknown;
              try {
                value = JSON.parse(String(item.values.value));
              } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                return false;
              }
              return value !== null && typeof value === "object" && "storage" in value
                && value.storage === bindings.storage;
            }));
          }
          const result = rows[queryId];
          assert.ok(result, "Only registered projections may be used.");
          return Promise.resolve(result);
        },
      };
    },
  };
}

test("native submissions preserve displayed/transformed text, stable identities, original order and exact byte anchors", async () => {
  const submission = event("user.message", "u1", {
    messageId: "logical-1", interactionId: "interaction-1",
    content: "Fictional caf\u00e9 <script>not executable</script>",
    transformedContent: "<prompt>Different model-facing text</prompt>",
    source: "user", delivery: "queued", turnId: "turn-1",
    parentAgentTaskId: "parent-task-native",
  });
  const records = [start(), submission, event("user.message", "u2", { content: submission.data.content })];
  const view = await agentHostConversationReader.read(input(records));
  assert.equal(view.events.length, 2);
  const first = view.events[0];
  assert.ok(first?.kind === "message");
  assert.equal(first.text, submission.data.content);
  assert.equal(first.nativeMessage?.transformedContent, submission.data.transformedContent);
  assert.equal(first.nativeMessage?.delivery, "queued");
  assert.equal(first.nativeMessage?.attribution, "human");
  assert.equal(first.nativeMessage?.parentAgentTaskId, "parent-task-native");
  assert.equal(first.nativeId, "u1");
  assert.equal(first.parentNativeId, "start");
  assert.equal(first.timestampMs, 1793700000001);
  assert.notEqual(first.instructionId, view.events[1]?.kind === "message" ? view.events[1].instructionId : null);
  const reference = first.references[0];
  assert.ok(reference?.location.kind === "jsonl");
  assert.equal(reference.location.line, 2);
  assert.equal(reference.location.pointer, "");
  const prefix = Buffer.byteLength(JSON.stringify(records[0]) + "\n");
  assert.equal(reference.location.byteOffset, prefix);
  assert.equal(reference.location.byteLength, Buffer.byteLength(JSON.stringify(submission)));
  assert.equal(reference.recordId, `sha256:${createHash("sha256").update(JSON.stringify(submission)).digest("hex")}`);
  const refreshed = await agentHostConversationReader.read(input(records, { readId: "another-generation" }));
  assert.notEqual(refreshed.events[0]?.id, first.id);
  assert.equal(refreshed.events[0]?.kind === "message" ? refreshed.events[0].instructionId : null, first.instructionId);
  assert.equal(view.sessions[0]?.parentNativeId, "sdk-parent");
  assert.deepEqual(view.sessions[0]?.nativeSession, {
    parentChatId: "ahp-chat:/parent", originSessionId: "copilotcli:/origin",
    archived: true, historyScope: "retained-native-log",
  });
  assert.deepEqual(view.sessions[0]?.nativeIdentities, [
    { namespace: "copilot-sdk-session", value: "sdk-fictional" },
    { namespace: "agent-host-session", value: "ahp-session:/runtime" },
    { namespace: "agent-host-chat", value: "ahp-chat:/runtime" },
    { namespace: "agent-host-storage-session", value: "copilotcli:/stored" },
    { namespace: "agent-host-storage-chat", value: "copilotcli:/stored/chat" },
  ]);
  assert.ok(view.sessions[0]?.references.some((ref) => ref.location.kind === "sqlite" && ref.location.table === "chats_v2" && ref.location.key[0]?.value === "copilotcli:/stored/chat"));
  assert.equal(view.sources[0]?.coverage.messages.status, "partial");
  assert.equal(view.sources[0]?.coverage.tokens.status, "unavailable");
});

test("automatic, subagent, malformed attribution and queue snapshots never become human instructions", async () => {
  const view = await agentHostConversationReader.read(input([
    start(),
    event("user.message", "system", { content: "injected", source: "skill-example" }),
    event("user.message", "auto", { content: "continue", source: "user", isAutopilotContinuation: true }),
    event("user.message", "child", { content: "child task", source: "agent-root" }, { agentId: "child-native" }),
    event("user.message", "bad", { content: "unknown", source: 12 }),
    event("pending_messages.modified", "queued", { pendingMessages: [{ messageId: "not-sent", content: "draft" }] }),
    event("tool.execution_complete", "tool", { result: { content: "not a human message" } }),
    event("system.message", "internal", { content: "internal instruction" }),
    event("user.message", "genuine", { content: "real submission", delivery: "steering" }),
  ]));
  const messages = view.events.filter((item) => item.kind === "message");
  assert.deepEqual(messages.map((item) => item.nativeMessage?.attribution), ["system", "system", "subagent", "unknown", "human"]);
  assert.equal(messages.filter((item) => item.instructionId !== null).length, 1);
  assert.equal(messages[2]?.nativeMessage?.agentId, "child-native");
  assert.equal(messages[1]?.nativeMessage?.isAutopilotContinuation, true);
  assert.ok(view.issues.some((item) => item.code === "unsupported-schema"));
});

test("exact event/logical-message replays merge anchors, while repeated text remains distinct", async () => {
  const submission = event("user.message", "one", { messageId: "stable", content: "same" });
  const view = await agentHostConversationReader.read(input([
    start(), submission, submission,
    { ...submission, id: "replayed", parentId: "one" },
    event("session.resume", "resume", {}),
    event("user.message", "new", { messageId: "different", content: "same" }),
  ]));
  assert.equal(view.events.length, 2);
  assert.equal(view.events[0]?.references.length, 3);
  assert.deepEqual(view.events[0]?.kind === "message" ? view.events[0].nativeMessage?.eventIds : null, ["one", "replayed"]);
  assert.deepEqual(view.events.map((item) => item.nativeId), ["one", "new"]);
});

test("conflicting native or logical identities remain diagnosed instead of inventing multiple instructions", async () => {
  for (const logical of [false, true]) {
    const view = await agentHostConversationReader.read(input([
      start(),
      event("user.message", "one", { messageId: "stable", content: "first" }),
      event("user.message", logical ? "two" : "one", { messageId: "stable", content: "conflict" }),
    ]));
    assert.equal(view.events.length, 0);
    const conflict = view.issues.find((item) => item.code === "ambiguous-session");
    assert.equal(conflict?.references?.length, 2);
  }
});

test("logical IDs cannot alias fallback event IDs or rescue a conflicting envelope", async () => {
  const distinct = await agentHostConversationReader.read(input([
    start(),
    event("user.message", "first", { messageId: "second", content: "same" }),
    event("user.message", "second", { content: "same" }),
  ]));
  assert.equal(distinct.events.length, 2);
  assert.notEqual(distinct.events[0]?.kind === "message" ? distinct.events[0].instructionId : null,
    distinct.events[1]?.kind === "message" ? distinct.events[1].instructionId : null);
  const conflicted = await agentHostConversationReader.read(input([
    start(),
    event("user.message", "first", { messageId: "stable", content: "first" }),
    event("user.message", "first", { messageId: "stable", content: "conflict" }),
    event("user.message", "replay", { messageId: "stable", content: "first" }),
  ]));
  assert.equal(conflicted.events.length, 0);
});

test("authoritative assistant messages supersede deltas without joining split responses or inventing interrupted completions", async () => {
  const view = await agentHostConversationReader.read(input([
    start(),
    event("assistant.message_delta", "delta", { messageId: "response", deltaContent: "par" }, { ephemeral: true }),
    event("assistant.message", "answer", {
      messageId: "response", content: "part one", apiCallId: "call", chunkIndex: 0, chunkCount: 2,
      requestId: "github-request", clientRequestId: "client-request", serviceRequestId: "service-request",
      originatingMessageId: "original-user", parentToolCallId: "parent-tool",
    }),
    event("assistant.message", "answer2", { messageId: "response2", content: "part two", apiCallId: "call", chunkIndex: 1, chunkCount: 2 }),
    event("assistant.message_delta", "interrupted", { messageId: "unfinished", deltaContent: "not complete" }, { ephemeral: true }),
  ]));
  assert.deepEqual(view.events.map((item) => item.kind === "message" ? item.text : null), ["part one", "part two"]);
  assert.ok(view.events.every((item) => item.kind === "message" && item.instructionId === null && item.nativeMessage?.completeness === "response-part"));
  assert.equal(view.issues.filter((item) => item.message.includes("Interrupted assistant")).length, 1);
  assert.equal(view.events[0]?.kind === "message" ? view.events[0].nativeMessage?.apiCallId : null, "call");
  const native = view.events[0]?.kind === "message" ? view.events[0].nativeMessage : null;
  assert.equal(native?.requestId, "github-request");
  assert.equal(native?.clientRequestId, "client-request");
  assert.equal(native?.serviceRequestId, "service-request");
  assert.equal(native?.originatingMessageId, "original-user");
  assert.equal(native?.parentToolCallId, "parent-tool");
});

test("missing timing/content, compaction, unknown records and damaged tails remain explicit", async () => {
  const records = [
    start(),
    event("user.message", "missing", {}, { timestamp: undefined, parentId: "not-retained" }),
    event("user.message", "empty", { content: "" }),
    event("session.compaction_complete", "compact", { success: true }),
    event("session.truncation", "truncate", { messagesRemovedDuringTruncation: 2 }),
    event("future.type", "future", {}),
  ];
  const raw = records.map((value) => JSON.stringify(value)).join("\n") + '\n{"id":"interrupted"';
  const view = await agentHostConversationReader.read(input(records, { raw }));
  assert.equal(view.events[0]?.kind === "message" ? view.events[0].text : "wrong", null);
  assert.equal(view.events[0]?.kind === "message" ? view.events[0].timestampMs : "wrong", null);
  assert.equal(view.events[1]?.kind === "message" ? view.events[1].text : "wrong", "");
  assert.ok(view.issues.some((item) => item.code === "unknown-record"));
  assert.ok(view.issues.some((item) => item.message.includes("predecessor")));
  assert.equal(view.issues.filter((item) => item.code === "truncated-record").length, 3);
  const damaged = view.issues.find((item) => item.message.includes("malformed, oversized or interrupted"));
  const location = damaged?.references?.[0]?.location;
  assert.ok(location?.kind === "jsonl");
  assert.equal(location.line, 7);
  assert.equal(location.byteOffset, Buffer.byteLength(records.map((value) => JSON.stringify(value)).join("\n") + "\n"));
});

test("calendar-invalid timestamps remain null while leap days, fractions and offsets retain exact milliseconds", async () => {
  for (const sample of [
    { timestamp: "2026-02-30T10:00:00Z", expected: null },
    { timestamp: "2025-02-29T10:00:00Z", expected: null },
    { timestamp: "2100-02-29T10:00:00Z", expected: null },
    { timestamp: "2026-04-31T10:00:00Z", expected: null },
    { timestamp: "2026-02-28T24:00:00Z", expected: null },
    { timestamp: "2026-02-28T10:00:60Z", expected: null },
    { timestamp: "2026-02-28Tnot-a-timeZ", expected: null },
    { timestamp: "2026-02-28T10:00:00", expected: null },
    { timestamp: "2024-02-29T10:00:00Z", expected: 1709200800000 },
    { timestamp: "2024-02-29T10:00:00.123456Z", expected: 1709200800123 },
    { timestamp: "2024-02-29T12:30:00+02:30", expected: 1709200800000 },
    { timestamp: "2024-02-29T03:00:00-07:00", expected: 1709200800000 },
  ]) {
    const view = await agentHostConversationReader.read(input([
      start(), event("user.message", "u", { content: "dated submission" }, { timestamp: sample.timestamp }),
    ]));
    const message = view.events[0];
    assert.ok(message?.kind === "message");
    assert.equal(message.timestampMs, sample.expected, sample.timestamp);
    assert.equal(view.issues.some((issue) => issue.message.includes("Message timestamp")), sample.expected === null);
  }
});

test("missing response chunks and malformed optional identities never claim a complete response or human instruction", async () => {
  const view = await agentHostConversationReader.read(input([
    start(),
    event("assistant.message", "answer", { messageId: "answer", content: "only part", apiCallId: "call", chunkIndex: 1, chunkCount: 3 }),
    event("user.message", "bad", { messageId: "", content: "unknown attribution" }, { parentId: 7 }),
  ]));
  assert.ok(view.issues.some((item) => item.message.includes("response parts are missing")));
  assert.ok(view.issues.some((item) => item.message.includes("predecessor identity is malformed")));
  assert.equal(view.events[1]?.kind === "message" ? view.events[1].instructionId : "wrong", null);
  assert.equal(view.events[1]?.kind === "message" ? view.events[1].nativeMessage?.attribution : "wrong", "unknown");
});

test("malformed captured chunk ordinals remain response parts even when no ordinal survives validation", async () => {
  const chunks: readonly Record<string, unknown>[] = [
    { chunkIndex: -1 },
    { chunkCount: 0 },
    { chunkIndex: null },
    { chunkIndex: -1, chunkCount: 0 },
    { chunkIndex: "0", chunkCount: "1" },
    { chunkIndex: 0.5, chunkCount: 1 },
  ];
  const view = await agentHostConversationReader.read(input([
    start(),
    ...chunks.map((fields, index) => event("assistant.message", `part-${index}`, {
      content: "damaged response part", apiCallId: `call-${index}`, ...fields,
    })),
  ]));
  assert.equal(view.events.length, chunks.length);
  assert.ok(view.events.every((item) => item.kind === "message" && item.nativeMessage?.completeness === "response-part"));
  assert.equal(view.issues.filter((item) => item.message.includes("response chunk identity is incomplete")).length, chunks.length);
  assert.equal(view.issues.filter((item) => item.message.includes("response parts are missing")).length, chunks.length);
});

test("unexpected assistant chunk fields never reclassify user submissions or their human attribution", async () => {
  const chunks: readonly Record<string, unknown>[] = [
    { chunkIndex: 0, chunkCount: 1 },
    { chunkIndex: -1 },
    { chunkCount: 0 },
    { chunkIndex: null, chunkCount: "damaged" },
  ];
  const view = await agentHostConversationReader.read(input([
    start(),
    ...chunks.map((fields, index) => event("user.message", `user-${index}`, {
      content: "submitted instruction", source: "user", ...fields,
    })),
  ]));
  assert.equal(view.events.length, chunks.length);
  for (const message of view.events) {
    assert.ok(message.kind === "message");
    assert.equal(message.nativeMessage?.attribution, "human");
    assert.equal(message.nativeMessage?.completeness, "captured-message");
    assert.equal(message.nativeMessage?.chunkIndex, null);
    assert.equal(message.nativeMessage?.chunkCount, null);
    assert.ok(message.instructionId);
  }
  assert.equal(view.issues.filter((item) => item.message.includes("Unexpected assistant chunk metadata")).length, chunks.length);
});

test("unsupported native identities/versions and missing inputs never become successful empty sessions", async () => {
  for (const changed of [
    { version: 2 }, { producer: "foreign" }, { copilotVersion: "new-unqualified" },
  ]) {
    const value = start();
    const view = await agentHostConversationReader.read(input([{ ...value, data: { ...value.data, ...changed } }]));
    assert.equal(view.sessions.length, 0);
    assert.equal(view.sources[0]?.coverage.messages.status, "unavailable");
    assert.ok(view.issues.some((item) => item.code === "unsupported-schema"));
  }
  for (const options of [{ catalogMissing: true }, { historyMissing: true }, { userVersion: 23 }]) {
    const view = await agentHostConversationReader.read(input([start()], options));
    assert.equal(view.events.length, 0);
    assert.equal(view.sessions.length, 0);
    assert.ok(view.issues.length);
    assert.ok(view.sources.every((source) => source.coverage.messages.status === "unavailable"));
  }
  const noStart = await agentHostConversationReader.read(input([event("user.message", "u", { content: "orphan" })]));
  assert.equal(noStart.sessions.length, 0);
});

test("ambiguous/deleted/wrong-provider/legacy/stale catalog ownership fails closed", async () => {
  const cases: ((rows: Record<string, SqliteRow[]>) => void)[] = [
    (rows) => { rows.sdk_chats = []; },
    (rows) => { rows.sdk_chats = [...rows.sdk_chats ?? [], row("chats_v2", { ...rows.sdk_chats?.[0]?.values, chat_uri: "other-chat" })]; },
    (rows) => { rows.sdk_chats = [row("chats_v2", { ...rows.sdk_chats?.[0]?.values, tombstoned: 1n })]; },
    (rows) => { rows.owner = [row("sessions_v2", { ...rows.owner?.[0]?.values, provider: "other-provider" })]; },
    (rows) => { rows.authority = [row("session_chat_catalogs", { ...rows.authority?.[0]?.values, authority_version: 1n })]; },
    (rows) => { rows.authority = [row("session_chat_catalogs", { ...rows.authority?.[0]?.values, projected_revision: 2n })]; },
    (rows) => { rows.authority = [row("session_chat_catalogs", { ...rows.authority?.[0]?.values, session_generation: "old-generation" })]; },
    (rows) => { rows.identity_metadata?.push(row("metadata", { key: "sessionTombstone:ahp-session:/runtime", value: "true" })); },
    (rows) => { rows.identity_metadata?.push(row("metadata", { key: "sessionHidden:copilotcli:/stored", value: "copilotcli" })); },
    (rows) => { rows.identity_metadata?.push(row("metadata", { key: "sessionsV2Excluded:copilotcli:copilotcli:/stored", value: "excluded" })); },
    (rows) => { rows.identity_metadata?.push(row("metadata", { key: "sessionStorageIdentity:ahp-session:/other", value: '{"runtime":"ahp-session:/other","storage":"copilotcli:/stored","provider":"copilotcli"}' })); },
    (rows) => { rows.identity_metadata?.push(row("metadata", { key: "chatAgentProvider:copilotcli:/stored/chat", value: "claude" })); },
    (rows) => { rows.identity_metadata?.push(row("metadata", { key: "chatAgentProvider:ahp-chat:/runtime", value: "claude" })); },
  ];
  for (const mutate of cases) {
    const rows = catalogRows();
    mutate(rows);
    const view = await agentHostConversationReader.read(input([start(), event("user.message", "u", { content: "not qualified" })], { rows }));
    assert.equal(view.sessions.length, 0);
    assert.equal(view.events.length, 0);
    assert.ok(view.issues.some((item) => item.code === "ambiguous-session"));
  }
});

test("malformed deletion flags on competing catalog matches cannot silently choose another owner", async () => {
  for (const tombstoned of [null, "0", "deleted", 2n, -1n, 0.5]) {
    const rows = catalogRows();
    const original = rows.sdk_chats?.[0];
    assert.ok(original);
    rows.sdk_chats?.push(row("chats_v2", {
      ...original.values, chat_uri: "competing-chat", tombstoned,
    }));
    const view = await agentHostConversationReader.read(input([start()], { rows }));
    assert.equal(view.sessions.length, 0);
    assert.ok(view.sources.every((source) => source.coverage.messages.status === "unavailable"));
    const problem = view.issues.find((item) => item.message.includes("unsupported deletion flag"));
    assert.equal(problem?.references?.filter((reference) => reference.location.kind === "sqlite"
      && reference.location.table === "chats_v2").length, 2);
    assert.ok(problem?.references?.some((reference) => reference.location.kind === "sqlite"
      && reference.location.key[0]?.value === "competing-chat"));
  }
});

test("request-scoped catalog snapshots cannot qualify ownership by mixing interleaved commits", async () => {
  const rows = catalogRows();
  const chat = rows.sdk_chats?.[0];
  const authority = rows.authority?.[0];
  assert.ok(chat && authority);
  rows.authority = [row("session_chat_catalogs", { ...authority.values, projected_revision: 2n })];
  const source = input([start(), event("user.message", "u", { content: "unqualified" })], { rows });
  let queries = 0;
  const changing: MultiSourceInput = {
    ...source,
    get(key) {
      const selected = source.get(key);
      if (!selected.available || selected.kind !== "sqlite") return selected;
      return {
        ...selected, snapshotScope: "request",
        async query(queryId, bindings) {
          queries++;
          const result = await selected.query(queryId, bindings);
          if (queryId === "sdk_chats") {
            rows.sdk_chats = [row("chats_v2", { ...chat.values, tombstoned: 1n })];
            rows.authority = [authority];
          }
          return result;
        },
      };
    },
  };
  const view = await agentHostConversationReader.read(changing);
  assert.equal(view.sessions.length, 0);
  assert.equal(view.events.length, 0);
  assert.ok(view.sources.every((source) => source.coverage.messages.status === "unavailable"));
  assert.ok(view.issues.some((issue) => issue.message.includes("connection-scoped catalog snapshot")));
  assert.equal(queries, 0);
});

test("ambiguous session and chat mappings retain both original metadata witnesses", async () => {
  for (const mapping of [
    { prefix: "session", original: "ahp-session:/runtime", other: "ahp-session:/other", storage: "copilotcli:/stored" },
    { prefix: "chat", original: "ahp-chat:/runtime", other: "ahp-chat:/other", storage: "copilotcli:/stored/chat" },
  ]) {
    const rows = catalogRows();
    const originalKey = `${mapping.prefix}StorageIdentity:${mapping.original}`;
    const original = rows.identity_metadata?.find((item) => item.values.key === originalKey);
    assert.ok(original);
    const conflicting = row("metadata", {
      key: `${mapping.prefix}StorageIdentity:${mapping.other}`,
      value: JSON.stringify({ runtime: mapping.other, storage: mapping.storage, provider: "copilotcli" }),
    });
    rows.identity_metadata?.push(conflicting);
    const view = await agentHostConversationReader.read(input([start()], { rows }));
    assert.equal(view.sessions.length, 0);
    const problem = view.issues.find((item) => item.code === "ambiguous-session");
    for (const witness of [original, conflicting])
      assert.ok(problem?.references?.some((reference) => reference.location.kind === "sqlite"
        && reference.location.table === "metadata"
        && reference.location.key[0]?.value === witness.values.key
        && reference.location.fingerprint === witness.fingerprint));
  }
});

test("recorded session-backed chats without provider data resolve by storage, never chat names or guessed owners", async () => {
  const rows = catalogRows();
  const stored = row("chats_v2", {
    ...rows.sdk_chats?.[0]?.values,
    provider_data: null,
    storage_resource: "copilotcli:/sdk-fictional",
  });
  rows.sdk_chats = [];
  rows.session_backed_chats = [stored];
  const view = await agentHostConversationReader.read(input([
    start(), event("user.message", "u", { content: "stored session" }),
  ], { rows }));
  assert.equal(view.events.length, 1);
  assert.equal(view.sessions[0]?.nativeId, "sdk-fictional");
  assert.ok(view.sessions[0]?.nativeIdentities?.some((identity) => identity.namespace === "agent-host-storage-chat" && identity.value === "copilotcli:/stored/chat"));
  rows.sdk_chats = catalogRows().sdk_chats ?? [];
  const ambiguous = await agentHostConversationReader.read(input([start()], { rows: {
    ...rows,
    session_backed_chats: [row("chats_v2", { ...stored.values, chat_uri: "other-chat" })],
  } }));
  assert.equal(ambiguous.sessions.length, 0);
});

test("native reads honor cancellation and reject underlying query failures rather than hiding them", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(agentHostConversationReader.read(input([start()], { signal: controller.signal })), { name: "AbortError" });
  const source = input([start()]);
  const broken: MultiSourceInput = {
    ...source,
    get(key) {
      const selected = source.get(key);
      return selected.available && selected.kind === "sqlite"
        ? { ...selected, query() { return Promise.reject(new Error("synthetic-query-failure")); } }
        : selected;
    },
  };
  await assert.rejects(agentHostConversationReader.read(broken), /synthetic-query-failure/);
});

test("native catalog isolates malformed JSON and large unrelated metadata while enforcing relevant-row limits", {
  skip: !process.env.AGENT_INSIGHTS_TEST_NATIVE_ROOT,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-native-chat-"));
  const database = path.join(root, "catalog.db");
  const file = path.join(root, "events.jsonl");
  const writer = new DatabaseSync(database);
  const service = new RuntimeService(
    await SourceAccess.create([root]),
    { sources: [root], port: 0, harness: "copilot", model: null, copilotPath: path.join(root, "no-model") },
    [], 30000, null, productionMultiSourceReaders, testNativeHelper,
  );
  t.after(async () => {
    await service.close();
    writer.close();
    await rm(root, { recursive: true, force: true });
  });
  writer.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA user_version=22;
      CREATE TABLE chats_v2(chat_uri TEXT PRIMARY KEY NOT NULL, owner_session_uri TEXT, storage_resource TEXT, parent_chat TEXT, provider_data TEXT, tombstoned INTEGER, archived INTEGER, origin_session_uri TEXT);
      CREATE TABLE sessions_v2(session_uri TEXT PRIMARY KEY NOT NULL, provider TEXT, session_generation TEXT, verified INTEGER, is_chat_backing INTEGER);
      CREATE TABLE session_chat_catalogs(session_uri TEXT PRIMARY KEY NOT NULL, authority_version INTEGER, session_generation TEXT, revision INTEGER, projected_revision INTEGER);
      CREATE TABLE metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT);
    `);
  for (const rows of Object.values(catalogRows()))
    for (const original of rows) {
      const names = Object.keys(original.values);
      writer.prepare(`INSERT INTO ${original.table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
        .run(...Object.values(original.values));
    }
  writer.prepare("INSERT INTO chats_v2 (chat_uri, provider_data) VALUES (?, ?)")
    .run("unrelated-corrupt-chat", "{malformed-json");
  const insertMetadata = writer.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
  writer.exec("BEGIN");
  for (let index = 0; index < 10_001; index++)
    insertMetadata.run(`unrelated:${index}`, index % 2 ? "scalar-not-json" : JSON.stringify({
      runtime: `unrelated-runtime:${index}`, storage: `unrelated-storage:${index}`,
    }));
  writer.exec("COMMIT");
  await writeFile(file, [start(), event("user.message", "u", { messageId: "logical", content: "synthetic only" })].map((value) => JSON.stringify(value)).join("\n"));
  const beforeFiles = (await readdir(root)).sort();
  // SHM coordination may change; closing a parent SHM descriptor also releases the fixture writer's POSIX locks.
  const evidenceFiles = beforeFiles.filter((name) => name !== "catalog.db-shm");
  const beforeBytes = await Promise.all(evidenceFiles.map((name) => readFile(path.join(root, name))));
  const selection = {
    readerId: "agent-host-conversations",
    sources: [
      { key: "history", sourceId: "source-1", relativePath: "events.jsonl" },
      { key: "catalog", sourceId: "source-1", relativePath: "catalog.db" },
    ],
  };
  const first = await service.readSet(selection, new AbortController().signal);
  assert.equal(first.events.length, 1, JSON.stringify(first.issues));
  assert.ok(first.sessions[0]?.nativeIdentities?.some((identity) =>
    identity.namespace === "agent-host-session" && identity.value === "ahp-session:/runtime"));
  assert.ok(first.sessions[0]?.references.some((ref) => ref.location.kind === "sqlite" && ref.location.fingerprint.length === 64));
  assert.deepEqual((await readdir(root)).sort(), beforeFiles);
  assert.deepEqual(await Promise.all(evidenceFiles.map((name) => readFile(path.join(root, name)))), beforeBytes);
  const refreshed = await service.readSet(selection, new AbortController().signal);
  assert.notEqual(refreshed.id, first.id);
  assert.equal(service.view?.id, refreshed.id);
  assert.equal(first.events[0]?.kind === "message" ? first.events[0].instructionId : null,
    refreshed.events[0]?.kind === "message" ? refreshed.events[0].instructionId : null);
  writer.exec("BEGIN");
  for (let index = 0; index < 10_001; index++)
    insertMetadata.run(`sessionStorageIdentity:conflict:${index}`, JSON.stringify({
      runtime: `conflict:${index}`, storage: "copilotcli:/stored", provider: "copilotcli",
    }));
  writer.exec("COMMIT");
  await assert.rejects(service.readSet(selection, new AbortController().signal), { code: "SQLITE_LIMIT" });
  assert.equal(service.view, null);
  await service.close();
  assert.equal(service.view, null);
});
