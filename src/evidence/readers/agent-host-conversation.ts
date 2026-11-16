/**
 * Reconstruct retained native Copilot messages only after Agent Host ownership is
 * established by the guarded catalog input. Captured text remains untrusted data.
 * No SDK restoration, source discovery, persistence, execution accounting or model call occurs.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { RuntimeError } from "../../runtime/errors.js";
import { parseReadView, type ReadView, type EvidenceReference } from "../contracts.js";
import type { MultiSourceInput, MultiSourceReader } from "../source-access.js";
import { jsonLines } from "./jsonl.js";
import { agentHostCatalogDefinition, resolveAgentHostOwnership } from "./agent-host-catalog.js";

/** Source events retain their first physical position and every exact replay anchor. */
interface NativeEvent {
  readonly value: Record<string, unknown>;
  readonly id: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly references: EvidenceReference[];
  conflict: boolean;
}

/** Mutable message assembly is confined to this generation; validation freezes published facts. */
type Message = Extract<ReadView["events"][number], { kind: "message" }>;
type NativeMessage = NonNullable<Message["nativeMessage"]>;

/** Independent retention ceilings include malformed records, blanks and exact replay anchors. */
const historyLimits = Object.freeze({
  recordBytes: 256 * 1024,
  totalBytes: 8 * 1024 * 1024,
  identities: 8192,
  records: 32768,
});

/** Reject impossible calendar dates before Date.parse can normalize them to another day. */
const nativeTimestamp = z.iso.datetime({ offset: true });

/** Types that cannot themselves establish a submitted instruction or complete response. */
const nonMessageEvents = new Set([
  "session.start", "session.resume", "session.shutdown", "session.idle",
  "session.info", "session.warning", "session.error", "session.title_changed",
  "assistant.turn_start", "assistant.turn_end", "assistant.idle",
  "assistant.reasoning", "assistant.reasoning_delta", "assistant.message_start",
  "tool.execution_start", "tool.execution_complete", "tool.execution_partial_result",
  "tool.execution_progress", "tool.shell_output",
  "subagent.started", "subagent.completed", "subagent.failed",
  "subagent.selected", "subagent.deselected", "subagent.configured",
  "system.message", "system.notification", "skill.invoked", "abort",
  "pending_messages.modified", "session.context_changed", "session.model_change",
]);

/** JSON objects only; arrays and null cannot supply event fields. */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Identifiers are retained verbatim, not trimmed, coerced or inferred from paths/text. */
function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Valid agent identity scopes logical messages; malformed agent variants cannot split a replay key. */
function messageKey(event: NativeEvent): string {
  const messageId = identifier(event.data.messageId);
  return JSON.stringify([
    event.type, identifier(event.value.agentId),
    messageId === null ? "event-id" : "message-id", messageId ?? event.id,
  ]);
}

/**
 * Read the qualified format-1 native stream and catalog within runtime-owned bounds/lifetimes.
 * Only retained user.message records establish instruction identity. Deltas, queued snapshots,
 * tools and lifecycle events never become extra instructions. Unsupported or incomplete data
 * remains visible through original-anchor diagnostics and unavailable/partial coverage.
 * Rejects with READ_LIMIT (413) before publishing any result when retention ceilings are exceeded.
 */
async function read(input: MultiSourceInput): Promise<ReadView> {
  const startedAtMs = Date.now();
  const history = input.get("history");
  const catalog = input.get("catalog");
  const issues: ReadView["issues"][number][] = [];
  const records = new Map<string, NativeEvent>();
  const malformedIds = new Map<string, EvidenceReference[]>();
  const conflictingMessages = new Set<string>();
  const events: Message[] = [];
  const sessions: ReadView["sessions"][number][] = [];
  let producer: string | null = null;
  let version: string | null = null;
  let qualified = false;
  /** Aggregate payload-free diagnostics while preserving all supplied original anchors. */
  const issue = (
    sourceId: string,
    code: ReadView["issues"][number]["code"],
    message: string,
    references: readonly EvidenceReference[] = [],
  ): void => {
    issues.push({ sourceId, code, message, ...(references.length ? { references } : {}) });
  };
  /** Publish even unavailable inputs, with no fabricated success or historical-completeness claim. */
  const finish = (): ReadView => {
    const unavailable = { status: "unavailable" as const, reason: "No qualified conversation evidence from this input." };
    const notExecution = { status: "unavailable" as const, reason: "Conversation reader does not establish execution timing, tools or token accounting." };
    return parseReadView({
      schemaVersion: 1,
      id: input.readId,
      startedAtMs,
      finishedAtMs: Date.now(),
      sources: [
        {
          id: history.sourceId,
          format: history.available ? "copilot-sdk-events-jsonl" : null,
          identity: { producer, version, executionHost: qualified ? "agent-host" : "unknown" },
          changedDuringRead: null,
          coverage: {
            messages: qualified
              ? { status: "partial", reason: "Retained native log only; historical branches, expired/deleted content and current model context are not reconstructed. See source issues for additional gaps." }
              : unavailable,
            timing: notExecution, tools: notExecution, tokens: notExecution,
          },
        },
        {
          id: catalog.sourceId,
          format: catalog.available ? "vscode-agenthost-catalog-sqlite" : null,
          identity: { producer: null, version: catalog.available && catalog.kind === "sqlite" ? String(catalog.userVersion) : null, executionHost: qualified ? "agent-host" : "unknown" },
          changedDuringRead: null,
          coverage: { messages: unavailable, timing: notExecution, tools: notExecution, tokens: notExecution },
        },
      ],
      sessions, events, issues,
    });
  };
  input.signal.throwIfAborted();
  if (!history.available || history.kind !== "file") {
    issue(history.sourceId, "unreadable-source", "Native history is unavailable; no archive or saved-chat fallback is attempted.");
    return finish();
  }
  for await (const line of jsonLines({
    readId: input.readId, sourceId: history.sourceId,
    bytes: history.bytes, signal: input.signal,
  }, {
    maxRecordBytes: historyLimits.recordBytes,
    onLine(line) {
      if (line.byteLength > historyLimits.recordBytes || line.line > historyLimits.records ||
          line.byteOffset + line.byteLength + (line.terminated ? 1 : 0) > historyLimits.totalBytes)
        throw new RuntimeError("READ_LIMIT", "Native history exceeded its record or retained-byte limit.", 413);
    },
  })) {
    const reference: EvidenceReference = {
      sourceId: history.sourceId,
      recordId: "error" in line ? `unparsed-line:${line.line}:byte:${line.byteOffset}` : line.recordId,
      location: { kind: "jsonl", line: line.line, pointer: "", byteOffset: line.byteOffset, byteLength: line.byteLength },
    };
    if ("error" in line) {
      issue(history.sourceId, line.terminated ? "unsupported-schema" : "truncated-record",
        "A native record is malformed, oversized or interrupted; its content was not reconstructed.", [reference]);
      continue;
    }
    const value = line.value;
    const id = object(value) ? identifier(value.id) : null;
    if (id !== null && !records.has(id) && !malformedIds.has(id) &&
        records.size + malformedIds.size >= historyLimits.identities)
      throw new RuntimeError("READ_LIMIT", "Native history exceeded its distinct-event identity limit.", 413);
    if (!object(value) || id === null || !identifier(value.type) || !object(value.data)) {
      if (id !== null) {
        const previous = records.get(id);
        if (previous) {
          previous.conflict = true;
          previous.references.push(reference);
          conflictingMessages.add(messageKey(previous));
        } else {
          const references = malformedIds.get(id) ?? [];
          references.push(reference);
          malformedIds.set(id, references);
        }
      }
      issue(history.sourceId, "unsupported-schema", "Native event envelope is unsupported.", [reference]);
      continue;
    }
    const previous = records.get(id);
    if (previous) {
      previous.references.push(reference);
      if (!isDeepStrictEqual(previous.value, value)) {
        previous.conflict = true;
        conflictingMessages.add(messageKey(previous));
        conflictingMessages.add(messageKey({
          value, id, type: String(value.type), data: value.data, references: [reference], conflict: true,
        }));
      }
    } else {
      const malformed = malformedIds.get(id) ?? [];
      const event: NativeEvent = {
        value, id, type: String(value.type), data: value.data,
        references: [...malformed, reference], conflict: malformed.length > 0,
      };
      records.set(id, event);
      if (event.conflict) conflictingMessages.add(messageKey(event));
      malformedIds.delete(id);
    }
  }
  const starts = [...records.values()].filter((event) => event.type === "session.start");
  const start = starts[0];
  producer = identifier(start?.data.producer);
  version = identifier(start?.data.copilotVersion);
  if (starts.length !== 1 || !start || start.conflict ||
      records.values().next().value !== start ||
      start.data.version !== 1 || start.data.producer !== "copilot-agent" ||
      start.data.copilotVersion !== "1.0.103-unstable.r41379698026.g3219c66" ||
      !identifier(start.data.sessionId) || start.value.agentId !== undefined ||
      start.value.parentId !== null) {
    issue(history.sourceId, "unsupported-schema", "A unique qualified format-1 session.start with the pinned producer/runtime is required.", starts.flatMap((event) => event.references));
    return finish();
  }
  const sdkSessionId = String(start.data.sessionId);
  if (!catalog.available || catalog.kind !== "sqlite") {
    issue(catalog.sourceId, "unreadable-source", "Agent Host catalog is unavailable; a shared native SDK file alone does not establish Agent Host ownership.");
    return finish();
  }
  const ownership = await resolveAgentHostOwnership(catalog, sdkSessionId, input.signal);
  if (!ownership.ok) {
    issue(catalog.sourceId, "ambiguous-session", ownership.reason, ownership.references);
    return finish();
  }
  qualified = true;
  const sessionId = `${input.readId}:sdk-session`;
  const parentNativeId = identifier(start.data.detachedFromSpawningParentSessionId);
  if (start.data.detachedFromSpawningParentSessionId !== undefined && parentNativeId === null)
    issue(history.sourceId, "unsupported-schema", "Captured detached-session parent identity is malformed; no parent was inferred.", start.references);
  sessions.push({
    id: sessionId,
    nativeId: sdkSessionId,
    parentNativeId,
    nativeSession: ownership.value.nativeSession,
    nativeIdentities: [{ namespace: "copilot-sdk-session", value: sdkSessionId }, ...ownership.value.identities],
    sourceIds: [history.sourceId, catalog.sourceId],
    references: [...start.references, ...ownership.value.references],
  });
  const messages = new Map<string, { event: NativeEvent; nativeIds: string[]; references: EvidenceReference[]; conflict: boolean }>();
  const deltas = new Map<string, EvidenceReference[]>();
  const completed = new Set<string>();
  for (const event of records.values()) {
    input.signal.throwIfAborted();
    if (event.conflict) {
      issue(history.sourceId, "ambiguous-session", "Conflicting replay of one native event identity was excluded.", event.references);
      continue;
    }
    const agentId = identifier(event.value.agentId);
    const messageId = identifier(event.data.messageId);
    const key = messageKey(event);
    if (event.type === "assistant.message_delta" || event.type === "assistant.message_start") {
      const streamKey = JSON.stringify([agentId, messageId]);
      const references = deltas.get(streamKey) ?? [];
      for (const reference of event.references) references.push(reference);
      deltas.set(streamKey, references);
      continue;
    }
    if (event.type !== "user.message" && event.type !== "assistant.message") {
      if (["session.compaction_start", "session.compaction_complete", "session.truncation", "session.context_cleared", "session.snapshot_rewind"].includes(event.type))
        issue(history.sourceId, "truncated-record", "Captured context/retention activity does not reconstruct removed history or establish the current transcript.", event.references);
      else if (!nonMessageEvents.has(event.type))
        issue(history.sourceId, "unknown-record", "A native event type is outside the qualified conversation mapping.", event.references);
      continue;
    }
    const previous = messages.get(key);
    if (previous) {
      previous.nativeIds.push(event.id);
      for (const reference of event.references) previous.references.push(reference);
      if (!isDeepStrictEqual({ ...previous.event.value, id: event.id }, event.value))
        previous.conflict = true;
    } else messages.set(key, { event, nativeIds: [event.id], references: [...event.references], conflict: false });
  }
  for (const candidate of messages.values()) {
    input.signal.throwIfAborted();
    const { event, nativeIds, references } = candidate;
    if (candidate.conflict || conflictingMessages.has(messageKey(event))) {
      issue(history.sourceId, "ambiguous-session", "Conflicting logical message identity was excluded rather than counted as multiple instructions.", references);
      continue;
    }
    const d = event.data;
    let malformed = false;
    /** Preserve absent strings as null; reported invalid values reduce coverage and cannot prove human attribution. */
    const text = (fields: Record<string, unknown>, key: string): string | null => {
      const value = fields[key];
      if (value === undefined) return null;
      if (typeof value === "string") return value;
      malformed = true;
      return null;
    };
    /** Empty identifiers are malformed, not aliases for absent identities or stable instruction IDs. */
    const nativeId = (fields: Record<string, unknown>, key: string): string | null => {
      const value = text(fields, key);
      if (value === "") {
        malformed = true;
        return null;
      }
      return value;
    };
    /** Preserve captured optional flags without interpreting missing values as false. */
    const flag = (fields: Record<string, unknown>, key: string): boolean | null => {
      const value = fields[key];
      if (value === undefined) return null;
      if (typeof value === "boolean") return value;
      malformed = true;
      return null;
    };
    /** Chunk ordinals are exact nonnegative safe integers; malformed ordinals never establish a whole utterance. */
    const ordinal = (key: string, minimum: number): number | null => {
      const value = d[key];
      if (value === undefined) return null;
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum) return value;
      malformed = true;
      return null;
    };
    const hasChunkMetadata = Object.hasOwn(d, "chunkIndex") || Object.hasOwn(d, "chunkCount");
    const hasResponseChunks = event.type === "assistant.message" && hasChunkMetadata;
    const native: NativeMessage = {
      eventIds: nativeIds,
      messageId: nativeId(d, "messageId"),
      interactionId: nativeId(d, "interactionId"),
      originatingMessageId: nativeId(d, "originatingMessageId"),
      requestId: nativeId(d, "requestId"),
      clientRequestId: nativeId(d, "clientRequestId"),
      serviceRequestId: nativeId(d, "serviceRequestId"),
      turnId: nativeId(d, "turnId"),
      agentId: nativeId(event.value, "agentId"),
      parentAgentTaskId: nativeId(d, "parentAgentTaskId"),
      parentToolCallId: nativeId(d, "parentToolCallId"),
      source: text(d, "source"),
      delivery: text(d, "delivery"),
      agentMode: text(d, "agentMode"),
      isAutopilotContinuation: flag(d, "isAutopilotContinuation"),
      ephemeral: flag(event.value, "ephemeral"),
      transformedContent: text(d, "transformedContent"),
      apiCallId: nativeId(d, "apiCallId"),
      chunkIndex: hasResponseChunks ? ordinal("chunkIndex", 0) : null,
      chunkCount: hasResponseChunks ? ordinal("chunkCount", 1) : null,
      attribution: "unknown",
      completeness: "captured-message",
    };
    const content = text(d, "content");
    const attribution: NativeMessage["attribution"] = event.type === "assistant.message" ? "assistant"
      : malformed || native.ephemeral === true ? "unknown"
      : native.agentId !== null ? "subagent"
      : native.isAutopilotContinuation === true || (native.source !== null && native.source.toLowerCase() !== "user") ? "system"
      : "human";
    if (malformed)
      issue(history.sourceId, "unsupported-schema", "A captured message has malformed attribution, identity, flag or content fields.", references);
    if (content === null)
      issue(history.sourceId, "missing-field", "Captured message content is absent or unsupported; null is not an empty submission.", references);
    if (hasChunkMetadata && !hasResponseChunks)
      issue(history.sourceId, "unsupported-schema", "Unexpected assistant chunk metadata on a user submission does not establish response parts or change instruction attribution.", references);
    if (hasResponseChunks) {
      if (!native.apiCallId || native.chunkIndex === null || native.chunkCount === null || native.chunkIndex >= native.chunkCount)
        issue(history.sourceId, "unsupported-schema", "Assistant response chunk identity is incomplete or conflicting.", references);
    }
    const timestamp = nativeTimestamp.safeParse(event.value.timestamp);
    const parsedTime = timestamp.success ? Date.parse(timestamp.data) : NaN;
    const timestampMs = Number.isSafeInteger(parsedTime) && parsedTime >= 0 ? parsedTime : null;
    if (timestampMs === null)
      issue(history.sourceId, "missing-field", "Message timestamp is absent or unsupported; no timing was inferred.", references);
    const parentNativeId = identifier(event.value.parentId);
    if (event.value.parentId !== undefined && event.value.parentId !== null && parentNativeId === null)
      issue(history.sourceId, "unsupported-schema", "Message predecessor identity is malformed; no parent was inferred.", references);
    if (parentNativeId && !records.has(parentNativeId))
      issue(history.sourceId, "missing-field", "Message predecessor is outside retained evidence; event-graph edges are not task boundaries.", references);
    events.push({
      id: `${input.readId}:message:${events.length}`,
      kind: "message",
      sessionId,
      nativeId: event.id,
      parentNativeId,
      instructionId: attribution === "human" ? JSON.stringify(["copilot-sdk-session", sdkSessionId, "user.message", native.messageId === null ? "event-id" : "message-id", native.messageId ?? event.id]) : null,
      role: event.type === "user.message" ? "user" : "assistant",
      text: content,
      timestampMs,
      references,
      nativeMessage: {
        ...native,
        attribution,
        completeness: content === null ? "missing-content"
          : hasResponseChunks ? "response-part" : "captured-message",
      },
    });
    if (event.type === "assistant.message" && native.messageId)
      completed.add(JSON.stringify([native.agentId, native.messageId]));
  }
  const responseParts = new Map<string, Message[]>();
  for (const event of events) {
    const native = event.nativeMessage;
    if (event.role !== "assistant" || !native?.apiCallId || native.completeness !== "response-part") continue;
    const key = JSON.stringify([native.agentId, native.apiCallId]);
    const parts = responseParts.get(key) ?? [];
    parts.push(event);
    responseParts.set(key, parts);
  }
  for (const parts of responseParts.values()) {
    const count = parts[0]?.nativeMessage?.chunkCount;
    const indices = new Set(parts.map((part) => part.nativeMessage?.chunkIndex));
    if (count === null || count === undefined || parts.length !== count || indices.size !== count ||
        parts.some((part) => {
          const native = part.nativeMessage;
          return !native || native.chunkCount !== count || native.chunkIndex === null || native.chunkIndex >= count;
        }))
      issue(history.sourceId, "truncated-record", "Assistant response parts are missing or conflicting; no complete utterance was assembled.", parts.flatMap((part) => part.references));
  }
  for (const [key, references] of deltas) {
    if (!completed.has(key))
      issue(history.sourceId, "truncated-record", "Interrupted assistant stream has no authoritative assistant.message; deltas are not invented complete responses.", references);
  }
  if (events.length === 0)
    issue(history.sourceId, "missing-field", "No qualified submitted or assistant messages were retained.");
  return finish();
}

/** Production composite reader; both sources require explicit grants, and all access stays behind #33. */
export const agentHostConversationReader: MultiSourceReader = Object.freeze({
  id: "agent-host-conversations",
  inputs: Object.freeze([
    { key: "history", kind: "file", format: "copilot-sdk-events-jsonl", optional: true },
    { key: "catalog", kind: "sqlite", format: "vscode-agenthost-catalog-sqlite", optional: true, database: agentHostCatalogDefinition },
  ] as const),
  read,
});
