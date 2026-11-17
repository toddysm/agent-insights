/**
 * Frame and qualify the pinned native SDK history once per reader invocation.
 * Retention limits include malformed records and replays; no source access,
 * Agent Host ownership, message reconstruction or execution accounting occurs here.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { RuntimeError } from "../../runtime/errors.js";
import type { EvidenceReference, ReadView } from "../contracts.js";
import type { SourceInput } from "../source-access.js";
import { jsonLines } from "./jsonl.js";

/** First retained envelope plus all exact replay anchors; conflicts must not contribute facts. */
export interface NativeEvent {
  readonly value: Record<string, unknown>;
  readonly id: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly references: EvidenceReference[];
  conflict: boolean;
}

/** JSON objects only; arrays and null cannot supply native fields. */
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve nonempty native identifiers verbatim, without trimming or coercion. */
export function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reject calendar-invalid dates before Date.parse can normalize them. */
export const nativeTimestamp = z.iso.datetime({ offset: true });

/** Logical message identity is scoped by agent; absent IDs use the original event, not text. */
export function nativeMessageKey(event: NativeEvent): string {
  const messageId = identifier(event.data.messageId);
  return JSON.stringify([
    event.type, identifier(event.value.agentId),
    messageId === null ? "event-id" : "message-id", messageId ?? event.id,
  ]);
}

/** Bounded native records and conflicting alternatives; a null start means no qualified format/runtime. */
export interface NativeHistory {
  readonly records: Map<string, NativeEvent>;
  readonly conflicts: readonly NativeEvent[];
  readonly issues: ReadView["issues"][number][];
  readonly start: NativeEvent | null;
  readonly producer: string | null;
  readonly version: string | null;
}

/**
 * Consume borrowed history with 256-KiB records, 8-MiB total bytes, 8192 IDs and 32768
 * physical records. Reject limit/cancellation failures without publishing a partial view.
 * Unsupported envelopes remain anchored diagnostics; conflicting IDs poison every valid variant.
 */
export async function readNativeHistory(
  history: SourceInput,
  readId: string,
  signal: AbortSignal,
): Promise<NativeHistory> {
  const records = new Map<string, NativeEvent>();
  const malformedIds = new Map<string, EvidenceReference[]>();
  const conflicts: NativeEvent[] = [];
  const issues: ReadView["issues"][number][] = [];
  /** Emit only fixed payload-free diagnostics, retaining original locations. */
  const issue = (code: ReadView["issues"][number]["code"], message: string, references: readonly EvidenceReference[] = []): void => {
    issues.push({ sourceId: history.sourceId, code, message, ...(references.length ? { references } : {}) });
  };
  signal.throwIfAborted();
  if (!history.available || history.kind !== "file") {
    issue("unreadable-source", "Native history is unavailable; no archive or saved-chat fallback is attempted.");
    return { records, conflicts, issues, start: null, producer: null, version: null };
  }
  for await (const line of jsonLines({
    readId, sourceId: history.sourceId, bytes: history.bytes, signal,
  }, {
    maxRecordBytes: 256 * 1024,
    onLine(line) {
      if (line.byteLength > 256 * 1024 || line.line > 32768 ||
          line.byteOffset + line.byteLength + (line.terminated ? 1 : 0) > 8 * 1024 * 1024)
        throw new RuntimeError("READ_LIMIT", "Native history exceeded its record or retained-byte limit.", 413);
    },
  })) {
    const reference: EvidenceReference = {
      sourceId: history.sourceId,
      recordId: "error" in line ? `unparsed-line:${line.line}:byte:${line.byteOffset}` : line.recordId,
      location: { kind: "jsonl", line: line.line, pointer: "", byteOffset: line.byteOffset, byteLength: line.byteLength },
    };
    if ("error" in line) {
      issue(line.terminated ? "unsupported-schema" : "truncated-record",
        "A native record is malformed, oversized or interrupted; its content was not reconstructed.", [reference]);
      continue;
    }
    const value = line.value;
    const id = object(value) ? identifier(value.id) : null;
    if (id !== null && !records.has(id) && !malformedIds.has(id) &&
        records.size + malformedIds.size >= 8192)
      throw new RuntimeError("READ_LIMIT", "Native history exceeded its distinct-event identity limit.", 413);
    if (!object(value) || id === null || !identifier(value.type) || !object(value.data)) {
      if (id !== null) {
        const previous = records.get(id);
        if (previous) {
          previous.conflict = true;
          previous.references.push(reference);
          conflicts.push(previous);
        } else {
          const references = malformedIds.get(id) ?? [];
          references.push(reference);
          malformedIds.set(id, references);
        }
      }
      issue("unsupported-schema", "Native event envelope is unsupported.", [reference]);
      continue;
    }
    const event: NativeEvent = { value, id, type: String(value.type), data: value.data, references: [reference], conflict: false };
    const previous = records.get(id);
    if (previous) {
      previous.references.push(reference);
      if (!isDeepStrictEqual(previous.value, value)) {
        previous.conflict = true;
        event.conflict = true;
        conflicts.push(previous, event);
      }
    } else {
      const malformed = malformedIds.get(id) ?? [];
      event.references.unshift(...malformed);
      event.conflict = malformed.length > 0;
      records.set(id, event);
      if (event.conflict) conflicts.push(event);
      malformedIds.delete(id);
    }
  }
  const starts = [...records.values()].filter((event) => event.type === "session.start");
  const start = starts[0];
  const producer = identifier(start?.data.producer);
  const version = identifier(start?.data.copilotVersion);
  if (starts.length !== 1 || !start || start.conflict || records.values().next().value !== start ||
      start.data.version !== 1 || start.data.producer !== "copilot-agent" ||
      start.data.copilotVersion !== "1.0.103-unstable.r41379698026.g3219c66" ||
      !identifier(start.data.sessionId) || start.value.agentId !== undefined || start.value.parentId !== null) {
    issue("unsupported-schema", "A unique qualified format-1 session.start with the pinned producer/runtime is required.", starts.flatMap((event) => event.references));
    return { records, conflicts, issues, start: null, producer, version };
  }
  return { records, conflicts, issues, start, producer, version };
}
