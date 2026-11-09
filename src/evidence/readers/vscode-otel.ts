/**
 * Read VS Code's extension OpenTelemetry JSON Lines export into transient evidence.
 * Only verified execution operations become events; mixed telemetry, corrupt
 * records and ambiguous identity never become invented executions or sessions.
 * No source paths, model calls, filesystem writes or captured-content logs occur.
 */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  parseReadView,
  type EvidenceReader,
  type ReaderInput,
  type ReadView,
} from "../contracts.js";
import { jsonLines } from "./jsonl.js";
import { ScanBudgetExceeded, type OtelScanPolicy } from "../streaming.js";

/** Shared normalized execution event, excluding reconstructed messages. */
type Span = Exclude<ReadView["events"][number], { kind: "message" }>;
/** Original-source locator carried by a normalized event. */
type Reference = Span["references"][number];
/** Explicit native session identifier with its producer-defined namespace. */
type Identity = NonNullable<
  ReadView["sessions"][number]["nativeIdentities"]
>[number];
/** Availability for one evidence dimension of the bounded read. */
type Coverage = ReadView["sources"][number]["coverage"]["timing"];
/** Public issue vocabulary accepted by the shared contract. */
type IssueCode = ReadView["issues"][number]["code"];

/** Classification uses only explicit operation metadata, never span labels or runtime identity. */
type OperationClassification =
  | { kind: "execution"; operation: string; eventKind: Span["kind"] }
  | { kind: "non-execution"; operation: "content_event" }
  | {
      kind: "unclassified";
      operation: string | null;
      reason:
        "missingOperation" | "malformedOperation" | "unsupportedOperation";
    };

/** Mutable assembly state only; published events are validated and frozen by parseReadView. */
interface Candidate {
  readonly line: number;
  readonly key: string;
  readonly parentKey: string | null;
  readonly facts: Omit<Span, "id" | "sessionId" | "references">;
  readonly identities: readonly Identity[];
  readonly producer: string | null;
  readonly version: string | null;
  readonly references: Reference[];
  conflict: boolean;
  /** Compact scans compare full normalized facts before discarding payloads. */
  signature?: string;
}

/**
 * Aggregate one payload-free issue per category. Small reads preserve supplied
 * references; compact scans retain the first affected anchor and exact count.
 */
class Diagnostics {
  /** Compact scans preserve the first affected anchor and exact occurrence count, not an unbounded reference list. */
  constructor(private readonly compact = false) {}
  private readonly entries = new Map<
    string,
    {
      code: IssueCode;
      message: string;
      count: number;
      line: number;
      references: Reference[];
    }
  >();

  /**
   * Accumulate a controlled message, count and first physical line, preserving
   * all supplied original references for each occurrence.
   * @param code - Shared public issue category.
   * @param message - Application-owned description, never source text or exception text.
   * @param line - First affected one-based source line.
   * @param references - Optional original anchors; never captured payloads.
   */
  add(
    code: IssueCode,
    message: string,
    line: number,
    references: readonly Reference[] = [],
  ): void {
    const key = `${code}:${message}`;
    const previous = this.entries.get(key);
    if (previous) {
      previous.count++;
      if (!this.compact)
        for (const ref of references) previous.references.push(ref);
    } else
      this.entries.set(key, {
        code,
        message,
        count: 1,
        line,
        references: this.compact ? references.slice(0, 1) : [...references],
      });
  }

  /** Whether limitations prevent a complete-coverage claim for this source. */
  get partial(): boolean {
    return this.entries.size > 0;
  }

  /**
   * Produce source-scoped, payload-free issues.
   * @param sourceId - Current authorized source identity.
   * @returns Aggregated issues with occurrence counts and first-line locations.
   */
  values(sourceId: string): ReadView["issues"] {
    return [...this.entries.values()].map((value) => ({
      sourceId,
      code: value.code,
      message: `${value.message} (${value.count} occurrence(s); first line ${value.line}).`,
      count: value.count,
      ...(value.references.length ? { references: value.references } : {}),
    }));
  }
}

/** Narrow parsed JSON objects without treating null/arrays as attribute records. */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve a nonempty captured identifier/name verbatim, or leave it unavailable. */
function name(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Classify an explicit operation without coercing malformed values or trimming reported names.
 * Missing and whitespace-only strings are absent; a nonempty unrecognized string
 * is unsupported. Invalid attribute containers/operation types remain malformed.
 */
function classifyOperation(attributes: unknown): OperationClassification {
  if (attributes === undefined)
    return {
      kind: "unclassified",
      operation: null,
      reason: "missingOperation",
    };
  if (!object(attributes))
    return {
      kind: "unclassified",
      operation: null,
      reason: "malformedOperation",
    };
  const operation = attributes["gen_ai.operation.name"];
  if (
    !Object.hasOwn(attributes, "gen_ai.operation.name") ||
    (typeof operation === "string" && operation.trim().length === 0)
  )
    return {
      kind: "unclassified",
      operation: null,
      reason: "missingOperation",
    };
  if (typeof operation !== "string")
    return {
      kind: "unclassified",
      operation: null,
      reason: "malformedOperation",
    };
  if (operation === "content_event")
    return { kind: "non-execution", operation };
  let eventKind: Span["kind"];
  if (operation === "chat" || operation === "embeddings")
    eventKind = "model-call";
  else if (operation === "execute_tool") eventKind = "tool-call";
  else if (operation === "invoke_agent") eventKind = "agent-span";
  else if (operation === "execute_hook") eventKind = "hook-execution";
  else
    return {
      kind: "unclassified",
      operation,
      reason: "unsupportedOperation",
    };
  return { kind: "execution", operation, eventKind };
}

/**
 * Preserve a captured name while distinguishing omission from malformed reported data.
 * @param fields - Parsed producer fields or attributes.
 * @param key - Application-owned field name, never a key taken from captured content.
 * @param diagnostics - Receives a payload-free limitation for a present invalid value.
 * @param line - Original physical source line.
 * @returns The verbatim nonempty string, or null without coercion.
 */
function reportedName(
  fields: Record<string, unknown>,
  key: string,
  diagnostics: Diagnostics,
  line: number,
): string | null {
  const value = name(fields[key]);
  if (Object.hasOwn(fields, key) && value === null)
    diagnostics.add("missing-field", `Invalid reported ${key}`, line);
  return value;
}

/**
 * Validate an OpenTelemetry identity without coercing or changing its spelling.
 * @param value - Captured identity; malformed and all-zero IDs are unavailable.
 * @param length - Required hexadecimal width: 16 for a span or 32 for a trace.
 * @returns The original valid value, otherwise null.
 */
function hex(value: unknown, length: number): string | null {
  return typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/.test(value) &&
    !/^0+$/.test(value)
    ? value
    : null;
}

/**
 * Convert producer tuples without accepting a different format's string units.
 * @param value - Epoch seconds and nanosecond remainder in [0, 1e9), both integers.
 * @returns Unix milliseconds, including representable fractions, or null for unsafe/invalid data.
 */
function milliseconds(value: unknown): number | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const seconds: unknown = value[0];
  const nanos: unknown = value[1];
  if (
    typeof seconds !== "number" ||
    typeof nanos !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1e9
  )
    return null;
  const result = seconds * 1000 + nanos / 1e6;
  return Number.isFinite(result) && result <= Number.MAX_SAFE_INTEGER
    ? result
    : null;
}

/**
 * Validate a reported count without converting strings, fractions or negative values.
 * @param value - Captured token/drop count.
 * @returns A nonnegative safe integer, including explicit zero, or null.
 */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Anchor an original physical record or a known field within it.
 * @param input - Current read/source identity.
 * @param line - One-based physical source line.
 * @param recordId - Original line fingerprint, excluding LF.
 * @param pointer - JSON Pointer into that original line, not a normalized object.
 */
function reference(
  input: ReaderInput,
  line: number,
  recordId: string,
  pointer = "",
): Reference {
  return {
    sourceId: input.sourceId,
    recordId,
    location: { kind: "jsonl", line, pointer },
  };
}

/** Encode an explicit native identity namespace/value without delimiter collisions. */
function identityKey(identity: Identity): string {
  return JSON.stringify([identity.namespace, identity.value]);
}

/**
 * Read reported usage; non-model accounting remains unknown rather than being added to model calls.
 * @param attributes - Validated attribute container; only named usage keys are interpreted.
 * @param kind - Normalized execution kind.
 * @param diagnostics - Receives malformed/conflicting components without captured values.
 * @param line - Original record line for diagnostics.
 * @returns Null when no usage was reported, otherwise explicit nullable totals/components.
 */
function usage(
  attributes: Record<string, unknown>,
  kind: Span["kind"],
  diagnostics: Diagnostics,
  line: number,
): Span["usage"] {
  const input = count(attributes["gen_ai.usage.input_tokens"]);
  const output = count(attributes["gen_ai.usage.output_tokens"]);
  const components: NonNullable<Span["usage"]>["components"][number][] = [];
  const componentKeys = [
    ["cache-read", "gen_ai.usage.cache_read.input_tokens"],
    ["cache-creation", "gen_ai.usage.cache_creation.input_tokens"],
    ["reasoning", "gen_ai.usage.reasoning.output_tokens"],
  ] as const;
  const keys = [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.reasoning_tokens",
    ...componentKeys.map(([, key]) => key),
  ];
  if (!keys.some((key) => Object.hasOwn(attributes, key))) return null;
  for (const key of keys) {
    if (Object.hasOwn(attributes, key) && count(attributes[key]) === null)
      diagnostics.add("missing-field", "Invalid reported token count", line);
  }
  for (const [component, key] of componentKeys) {
    let value = count(attributes[key]);
    if (component === "reasoning") {
      const legacy = count(attributes["gen_ai.usage.reasoning_tokens"]);
      if (value !== null && legacy !== null && value !== legacy) {
        diagnostics.add(
          "unknown-record",
          "Conflicting reasoning-token aliases",
          line,
        );
        value = null;
      } else value ??= legacy;
    }
    if (value !== null)
      components.push({ name: component, value, relation: "unknown" });
  }
  return {
    basis: kind === "model-call" ? "per-call" : "unknown",
    input,
    output,
    components,
  };
}

/**
 * Normalize one compatible span while retaining only typed captured fields.
 * @param raw - Original parsed span object.
 * @param input - Read/source identity used for original anchors.
 * @param line - Physical source line.
 * @param recordId - Original line fingerprint for later replacement detection.
 * @param diagnostics - Receives unsupported/missing-field limitations.
 * @param classification - Already classified explicit execution operation.
 * @returns A normalized candidate; hook content remains quoted evidence only.
 */
function span(
  raw: Record<string, unknown>,
  input: ReaderInput,
  line: number,
  recordId: string,
  diagnostics: Diagnostics,
  classification: Extract<OperationClassification, { kind: "execution" }>,
): Candidate {
  const attributes = raw.attributes;
  if (!object(attributes))
    throw new Error("Missing internally classified execution attributes");
  const { operation, eventKind: kind } = classification;
  const traceId = hex(raw.traceId, 32);
  const spanId = hex(raw.spanId, 16);
  const parent = object(raw.parentSpanContext) ? raw.parentSpanContext : null;
  const parentId = parent ? hex(parent.spanId, 16) : null;
  const parentTraceId = parent ? hex(parent.traceId, 32) : null;
  const validParent =
    parentId !== null &&
    parentTraceId !== null &&
    (traceId === null || parentTraceId === traceId) &&
    parentId !== spanId;
  if (traceId === null || spanId === null)
    diagnostics.add(
      "missing-field",
      "Missing or invalid native span identity",
      line,
    );
  if (raw.parentSpanContext !== undefined && !validParent)
    diagnostics.add("missing-field", "Invalid native parent context", line);
  const start = milliseconds(raw.startTime);
  const validCompletion =
    raw.ended === undefined || typeof raw.ended === "boolean";
  if (!validCompletion)
    diagnostics.add(
      "unknown-record",
      "Unsupported recorded completion flag",
      line,
    );
  if (
    raw.kind !== undefined &&
    (typeof raw.kind !== "number" ||
      !Number.isInteger(raw.kind) ||
      raw.kind < 0 ||
      raw.kind > 4)
  )
    diagnostics.add("unknown-record", "Unsupported native span kind", line);
  let end =
    raw.ended === false || !validCompletion ? null : milliseconds(raw.endTime);
  if (start !== null && end !== null && end < start) {
    end = null;
    diagnostics.add(
      "missing-field",
      "Recorded span end precedes its start",
      line,
    );
  }
  if (start === null || end === null)
    diagnostics.add("missing-field", "Incomplete recorded timing", line);
  const refs = [reference(input, line, recordId)];
  const identities: Identity[] = [];
  for (const [namespace, key] of [
    ["vscode-chat", "copilot_chat.chat_session_id"],
    ["gen-ai-conversation", "gen_ai.conversation.id"],
  ] as const) {
    const value = name(attributes[key]);
    if (Object.hasOwn(attributes, key) && value === null)
      diagnostics.add(
        "missing-field",
        "Invalid reported session identifier",
        line,
      );
    if (value !== null) {
      identities.push({ namespace, value });
      refs.push(reference(input, line, recordId, `/attributes/${key}`));
    }
  }
  /**
   * Retain a known captured content attribute without interpreting instructions.
   * @param key - Application-owned attribute name, also used in its original JSON Pointer.
   * @returns Captured string or null when absent/unsupported; records a controlled limitation.
   */
  const content = (key: string): string | null => {
    const value = attributes[key];
    if (value === undefined) return null;
    if (typeof value !== "string") {
      diagnostics.add(
        "missing-field",
        "Unsupported captured content representation",
        line,
      );
      return null;
    }
    refs.push(reference(input, line, recordId, `/attributes/${key}`));
    if (value.includes("[VS Code: value truncated for persistence"))
      diagnostics.add(
        "truncated-record",
        "Captured content contains a producer truncation marker",
        line,
      );
    return value;
  };
  const status = object(raw.status) ? raw.status.code : undefined;
  if (
    Object.hasOwn(raw, "status") &&
    (!object(raw.status) || (status !== 0 && status !== 1 && status !== 2))
  )
    diagnostics.add("unknown-record", "Unsupported recorded span status", line);
  for (const key of [
    "droppedAttributesCount",
    "droppedEventsCount",
    "droppedLinksCount",
  ]) {
    if (raw[key] === undefined) continue;
    const dropped = count(raw[key]);
    if (dropped === null)
      diagnostics.add("missing-field", "Invalid producer drop count", line);
    else if (dropped > 0)
      diagnostics.add(
        "truncated-record",
        "Producer reports dropped telemetry fields",
        line,
      );
  }
  if (!object(raw.resource) || !object(raw.resource.attributes))
    diagnostics.add(
      "missing-field",
      "Missing or invalid exporter resource metadata",
      line,
    );
  if (
    !object(raw.instrumentationScope) ||
    typeof raw.instrumentationScope.name !== "string"
  )
    diagnostics.add(
      "missing-field",
      "Missing or invalid exporter instrumentation scope",
      line,
    );
  const resource =
    object(raw.resource) && object(raw.resource.attributes)
      ? raw.resource.attributes
      : {};
  const requested = reportedName(
    attributes,
    "gen_ai.request.model",
    diagnostics,
    line,
  );
  const responded = reportedName(
    attributes,
    "gen_ai.response.model",
    diagnostics,
    line,
  );
  const agentName = reportedName(
    attributes,
    "gen_ai.agent.name",
    diagnostics,
    line,
  );
  const toolName = reportedName(
    attributes,
    "gen_ai.tool.name",
    diagnostics,
    line,
  );
  const toolCallId = reportedName(
    attributes,
    "gen_ai.tool.call.id",
    diagnostics,
    line,
  );
  const spanName = reportedName(raw, "name", diagnostics, line);
  const hook =
    kind === "hook-execution"
      ? {
          type: reportedName(
            attributes,
            "copilot_chat.hook_type",
            diagnostics,
            line,
          ),
          resultKind: reportedName(
            attributes,
            "copilot_chat.hook_result_kind",
            diagnostics,
            line,
          ),
          input: content("copilot_chat.hook_input"),
          output: content("copilot_chat.hook_output"),
        }
      : undefined;
  if (
    hook?.resultKind != null &&
    !["success", "error", "non_blocking_error"].includes(hook.resultKind)
  )
    diagnostics.add(
      "unknown-record",
      "Unsupported reported hook result kind",
      line,
    );
  if (
    kind === "tool-call" &&
    toolName === null &&
    !Object.hasOwn(attributes, "gen_ai.tool.name")
  )
    diagnostics.add("missing-field", "Tool name was not reported", line);
  return {
    line,
    key: traceId && spanId ? `${traceId}/${spanId}` : `line-${line}`,
    parentKey: validParent ? `${parentTraceId}/${parentId}` : null,
    facts: {
      kind,
      nativeId: spanId,
      parentNativeId: parentId,
      name:
        kind === "tool-call"
          ? toolName
          : ((kind === "hook-execution"
              ? hook?.type
              : kind === "model-call"
                ? (responded ?? requested)
                : agentName) ?? spanName),
      startedAtMs: start,
      endedAtMs: end,
      status: status === 1 ? "ok" : status === 2 ? "error" : "unknown",
      usage: usage(attributes, kind, diagnostics, line),
      trace: { id: traceId, parentId: parentTraceId },
      operation,
      spanName,
      tool: { name: toolName, callId: toolCallId },
      model: { requested, responded },
      ...(hook ? { hook } : {}),
      content: {
        inputMessages: content("gen_ai.input.messages"),
        outputMessages: content("gen_ai.output.messages"),
        toolArguments: content("gen_ai.tool.call.arguments"),
        toolResult: content("gen_ai.tool.call.result"),
      },
    },
    references: refs,
    identities,
    producer: reportedName(resource, "service.name", diagnostics, line),
    version: reportedName(resource, "service.version", diagnostics, line),
    conflict: false,
  };
}

/**
 * Associate within-read identities/parents without merging ambiguous alias namespaces.
 * @param candidates - Nonconflicting normalized candidates in original order.
 * @param input - Read/source identity used for generated session IDs.
 * @param diagnostics - Receives ambiguous/unassignable session limitations.
 * @returns Sessions and per-event associations; missing parents never create sessions.
 */
function associate(
  candidates: readonly Candidate[],
  input: ReaderInput,
  diagnostics: Diagnostics,
): {
  sessions: ReadView["sessions"];
  assignments: ReadonlyMap<string, string | null>;
} {
  const editorsByConversation = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const editor = candidate.identities.find(
      (i) => i.namespace === "vscode-chat",
    );
    const conversation = candidate.identities.find(
      (i) => i.namespace === "gen-ai-conversation",
    );
    if (editor && conversation) {
      const key = identityKey(conversation);
      const values = editorsByConversation.get(key) ?? new Set<string>();
      values.add(identityKey(editor));
      editorsByConversation.set(key, values);
    }
  }
  const nativeGroups = new Map<string, Identity>();
  const assignments = new Map<string, string | null>();
  for (const candidate of candidates) {
    const editor = candidate.identities.find(
      (i) => i.namespace === "vscode-chat",
    );
    const conversation = candidate.identities.find(
      (i) => i.namespace === "gen-ai-conversation",
    );
    if (editor) {
      const key = identityKey(editor);
      nativeGroups.set(key, editor);
      assignments.set(candidate.key, key);
    } else if (conversation) {
      const key = identityKey(conversation);
      const editors = editorsByConversation.get(key);
      if (editors && editors.size > 1) assignments.set(candidate.key, null);
      else if (editors?.size === 1)
        assignments.set(candidate.key, [...editors][0] ?? null);
      else {
        nativeGroups.set(key, conversation);
        assignments.set(candidate.key, key);
      }
    }
  }
  const byKey = new Map(
    candidates.map((candidate) => [candidate.key, candidate]),
  );
  // Explicit session IDs must not hide cycles in the separately reported parent graph.
  const checkedParents = new Set<string>();
  for (const candidate of candidates) {
    const chain = new Set<string>();
    let current: Candidate | undefined = candidate;
    while (
      current &&
      !checkedParents.has(current.key) &&
      !chain.has(current.key)
    ) {
      chain.add(current.key);
      current = current.parentKey ? byKey.get(current.parentKey) : undefined;
    }
    if (current && chain.has(current.key))
      diagnostics.add(
        "unknown-record",
        "Cycle in captured parent relationships",
        current.line,
      );
    for (const key of chain) checkedParents.add(key);
  }
  for (const candidate of candidates) {
    const chain: Candidate[] = [];
    const seen = new Set<string>();
    let current: Candidate | undefined = candidate;
    while (current && !assignments.has(current.key) && !seen.has(current.key)) {
      chain.push(current);
      seen.add(current.key);
      current = current.parentKey ? byKey.get(current.parentKey) : undefined;
    }
    const owner = current ? (assignments.get(current.key) ?? null) : null;
    for (const entry of chain) assignments.set(entry.key, owner);
    if (assignments.get(candidate.key) === null)
      diagnostics.add(
        "ambiguous-session",
        "Execution cannot be assigned to an unambiguous reported session",
        candidate.line,
      );
  }
  const groups = new Map<
    string,
    {
      native: Identity;
      identities: Map<string, Identity>;
      refs: Reference[];
      id: string;
    }
  >();
  for (const candidate of candidates) {
    const key = assignments.get(candidate.key);
    if (!key) continue;
    const native = nativeGroups.get(key);
    if (!native)
      throw new Error("Missing internally resolved session identity");
    let group = groups.get(key);
    if (!group) {
      group = {
        native,
        identities: new Map(),
        refs: [],
        id: `${input.readId}:session:${groups.size + 1}`,
      };
      groups.set(key, group);
    }
    for (const identity of candidate.identities)
      group.identities.set(identityKey(identity), identity);
    for (const ref of candidate.references) group.refs.push(ref);
  }
  return {
    sessions: [...groups.values()].map((group) => ({
      id: group.id,
      nativeId: group.native.value,
      nativeIdentities: [...group.identities.values()],
      sourceIds: [input.sourceId],
      references: group.refs,
    })),
    assignments: new Map(
      [...assignments].map(([key, group]) => [
        key,
        group ? (groups.get(group)?.id ?? null) : null,
      ]),
    ),
  };
}

/**
 * Consume the extension file exporter without reading or persisting any other source.
 * @param input - Authorized bounded byte stream and generation-owned cancellation.
 * @param policy - Optional code-owned scan ceilings; drops payloads only after full-fact
 * duplicate/conflict comparison and rejects rather than evicting correlation state.
 * @returns Immutable adapter candidate with original anchors and provisional assembly
 * timestamps. RuntimeService supplies published read timing and separate capture bounds.
 * @throws Rejects on cancellation, stream errors or an internal contract violation.
 */
async function read(input: ReaderInput, policy?: OtelScanPolicy): Promise<ReadView> {
  const startedAtMs = Date.now();
  const diagnostics = new Diagnostics(policy !== undefined);
  let retainedBytes = 0;
  let retainedReferences = 0;
  /** Conservatively charge decoded metadata and references before retaining another identity. */
  const reserve = (value: unknown, references = 0): void => {
    if (!policy) return;
    retainedBytes += 4 * Buffer.byteLength(JSON.stringify(value), "utf8") + 512;
    retainedReferences += references;
    if (retainedBytes > policy.maxMetadataBytes) throw new ScanBudgetExceeded("metadata");
    if (retainedReferences > policy.maxReferences) throw new ScanBudgetExceeded("references");
  };
  const candidates = new Map<string, Candidate>();
  const operations = new Map<
    string,
    { classification: OperationClassification; reference: Reference }
  >();
  const operationConflicts = new Set<string>();
  const nonExecutionRecords = { metrics: 0, logs: 0, contentEvents: 0 };
  let recognized = false;
  for await (const record of jsonLines(input, policy && {
    maxRecordBytes: policy.maxRecordBytes,
    onLine: (line) => {
      policy.onLine(line);
      policy.counts.records++;
      if (line.blank) policy.counts.blank++;
    },
  })) {
    if ("error" in record) {
      if (policy) {
        if (record.error === "oversized") policy.counts.oversized++;
        else if (!record.terminated) policy.counts.incomplete++;
        else policy.counts.malformed++;
      }
      diagnostics.add(
        record.terminated ? "unknown-record" : "truncated-record",
        record.error === "oversized"
          ? "Record exceeds the byte limit; excluded from execution coverage"
          : record.error === "encoding"
          ? "Invalid UTF-8 record"
          : "Malformed JSON record",
        record.line,
      );
      continue;
    }
    const raw = record.value;
    if (!object(raw)) {
      if (policy) policy.counts.unknown++;
      diagnostics.add(
        "unknown-record",
        "Unsupported telemetry record shape",
        record.line,
      );
      continue;
    }
    if (Array.isArray(raw.scopeMetrics)) {
      recognized = true;
      nonExecutionRecords.metrics++;
      if (policy) policy.counts.metrics++;
      continue;
    }
    if (
      milliseconds(raw.hrTime) !== null &&
      object(raw.resource) &&
      object(raw.instrumentationScope)
    ) {
      recognized = true;
      nonExecutionRecords.logs++;
      if (policy) policy.counts.logs++;
      continue;
    }
    const spanHeader =
      name(raw.name) !== null &&
      typeof raw.kind === "number" &&
      Number.isInteger(raw.kind) &&
      raw.kind >= 0 &&
      raw.kind <= 4;
    const isSpan =
      ("traceId" in raw || "spanId" in raw) &&
      ("startTime" in raw || "endTime" in raw || spanHeader);
    if (!isSpan) {
      if (policy) policy.counts.unknown++;
      diagnostics.add(
        "unknown-record",
        "Unsupported telemetry record shape",
        record.line,
      );
      continue;
    }
    recognized = true;
    const classification = classifyOperation(raw.attributes);
    if (classification.kind === "non-execution") {
      nonExecutionRecords.contentEvents++;
      if (policy) policy.counts.contentEvents++;
      continue;
    }
    if (policy) {
      if (classification.kind === "execution") policy.counts.executionRecords++;
      else policy.counts.unclassifiedRecords++;
    }
    const ref: Reference = {
      ...reference(input, record.line, record.recordId),
      ...(policy ? { location: {
        kind: "jsonl" as const, line: record.line, pointer: "",
        byteOffset: record.byteOffset, byteLength: record.byteLength,
      } } : {}),
    };
    const traceId = hex(raw.traceId, 32);
    const spanId = hex(raw.spanId, 16);
    // Filtering an unqualified execution must not hide a conflicting native identity.
    const key =
      traceId && spanId ? `${traceId}/${spanId}` : `line-${record.line}`;
    const earlier = operations.get(key);
    if (earlier) {
      if (!isDeepStrictEqual(earlier.classification, classification)) {
        operationConflicts.add(key);
        const previous = candidates.get(key);
        const refs =
          previous && !previous.conflict
            ? [...previous.references, ref]
            : [earlier.reference, ref];
        if (previous) previous.conflict = true;
        diagnostics.add(
          "unknown-record",
          "Conflicting execution operations share a native identity; excluded",
          record.line,
          refs,
        );
      }
    } else {
      if (policy && operations.size >= policy.maxIdentities) throw new ScanBudgetExceeded("identities");
      reserve({ key, classification, reference: ref }, 1);
      operations.set(key, { classification, reference: ref });
    }
    if (classification.kind === "unclassified") {
      const descriptions = {
        missingOperation:
          "Execution operation metadata is missing or empty; span unclassified",
        malformedOperation: object(raw.attributes)
          ? "Invalid execution operation metadata; span unclassified"
          : "Missing or invalid span attributes; span unclassified",
        unsupportedOperation:
          "Unsupported execution operation; span unclassified and excluded from trusted totals",
      };
      diagnostics.add(
        classification.reason === "unsupportedOperation"
          ? "unknown-record"
          : "missing-field",
        descriptions[classification.reason],
        record.line,
        [ref],
      );
      continue;
    }
    let candidate = span(
      raw,
      input,
      record.line,
      record.recordId,
      diagnostics,
      classification,
    );
    if (policy) {
      candidate.signature = createHash("sha256")
        .update(JSON.stringify([candidate.facts, candidate.identities, candidate.producer, candidate.version]))
        .digest("hex");
      candidate.references.splice(0, candidate.references.length, ref);
      // Full-fact signatures still detect conflicting content after payloads are discarded.
      candidate = {
        ...candidate,
        facts: {
          ...candidate.facts,
          ...(candidate.facts.hook ? { hook: { ...candidate.facts.hook, input: null, output: null } } : {}),
          content: { inputMessages: null, outputMessages: null, toolArguments: null, toolResult: null },
        },
      };
    }
    if (operationConflicts.has(candidate.key)) candidate.conflict = true;
    const previous = candidates.get(candidate.key);
    if (previous) {
      if (
        previous.conflict ||
        candidate.conflict ||
        (policy ? previous.signature !== candidate.signature : !isDeepStrictEqual(previous.facts, candidate.facts)) ||
        !isDeepStrictEqual(previous.identities, candidate.identities) ||
        previous.producer !== candidate.producer ||
        previous.version !== candidate.version
      ) {
        const refs = previous.conflict
          ? candidate.references
          : [...previous.references, ...candidate.references];
        previous.conflict = true;
        diagnostics.add(
          "unknown-record",
          "Conflicting records share a native span identity; excluded",
          record.line,
          refs,
        );
      }
      if (policy) {
        if (previous.signature === candidate.signature) policy.counts.duplicates++;
      } else previous.references.push(...candidate.references);
    } else {
      reserve(candidate, candidate.references.length);
      candidates.set(candidate.key, candidate);
      if (candidate.conflict)
        diagnostics.add(
          "unknown-record",
          "Conflicting records share a native span identity; excluded",
          record.line,
          candidate.references,
        );
    }
  }
  input.signal.throwIfAborted();
  const trusted = [...candidates.values()].filter(
    (candidate) => !candidate.conflict,
  );
  if (trusted.length === 0)
    diagnostics.add(
      "unsupported-schema",
      "No supported execution evidence is available",
      1,
    );
  const { sessions, assignments } = associate(trusted, input, diagnostics);
  const events = trusted.map((candidate) => ({
    ...candidate.facts,
    nativeIdentities: candidate.identities,
    id: `${input.readId}:event:${candidate.line}`,
    sessionId: assignments.get(candidate.key) ?? null,
    references: candidate.references,
  }));
  /**
   * Describe supported records in this read, not whole-session capture completeness.
   * @param available - At least one relevant value/record was captured.
   * @param complete - Every applicable captured record has the required fields.
   * @param reason - Controlled explanation used for unavailable or partial evidence.
   * @returns Coverage conservatively reduced by any read diagnostic.
   */
  const coverage = (
    available: boolean,
    complete: boolean,
    reason: string,
  ): Coverage =>
    !available
      ? { status: "unavailable", reason }
      : complete && !diagnostics.partial
        ? { status: "complete" }
        : { status: "partial", reason };
  const modelCalls = events.filter((event) => event.kind === "model-call");
  const unclassifiedSpans = {
    missingOperation: 0,
    malformedOperation: 0,
    unsupportedOperation: 0,
  };
  let conflictingSpans = 0;
  for (const [key, { classification }] of operations) {
    if (operationConflicts.has(key) || candidates.get(key)?.conflict)
      conflictingSpans++;
    else if (classification.kind === "unclassified")
      unclassifiedSpans[classification.reason]++;
  }
  const producers = new Set(trusted.map((candidate) => candidate.producer));
  const versions = new Set(trusted.map((candidate) => candidate.version));
  return parseReadView({
    schemaVersion: 1,
    id: input.readId,
    startedAtMs,
    finishedAtMs: Math.max(startedAtMs, Date.now()),
    sources: [
      {
        id: input.sourceId,
        format: recognized ? "vscode-otel-jsonl" : null,
        identity: {
          producer: producers.size === 1 ? ([...producers][0] ?? null) : null,
          version: versions.size === 1 ? ([...versions][0] ?? null) : null,
          executionHost: "unknown",
        },
        changedDuringRead: null,
        classification: {
          executions: {
            modelCalls: modelCalls.length,
            toolCalls: events.filter((event) => event.kind === "tool-call")
              .length,
            agentSpans: events.filter((event) => event.kind === "agent-span")
              .length,
            hookExecutions: events.filter(
              (event) => event.kind === "hook-execution",
            ).length,
          },
          unclassifiedSpans,
          conflictingSpans,
          nonExecutionRecords,
        },
        coverage: {
          messages: {
            status: "unavailable",
            reason: "Execution content is not a reconstructed conversation",
          },
          timing: coverage(
            events.some(
              (event) => event.startedAtMs !== null || event.endedAtMs !== null,
            ),
            events.every(
              (event) => event.startedAtMs !== null && event.endedAtMs !== null,
            ),
            "Recorded timing is missing or limited by read issues",
          ),
          tools: coverage(
            events.length > 0,
            events
              .filter((event) => event.kind === "tool-call")
              .every((event) => event.name !== null),
            "Tool evidence is missing or limited by read issues",
          ),
          tokens: coverage(
            modelCalls.some(
              (event) =>
                event.usage?.input != null || event.usage?.output != null,
            ),
            modelCalls.every(
              (event) =>
                event.usage?.input != null && event.usage?.output != null,
            ),
            "Per-call token usage is missing or limited by read issues",
          ),
        },
      },
    ],
    sessions,
    events,
    issues: diagnostics.values(input.sourceId),
  });
}

/** Production adapter for the inspected VS Code extension file exporter, not other JSON Lines formats. */
export const vscodeOtelReader: EvidenceReader = {
  format: "vscode-otel-jsonl",
  read,
};

/**
 * Use the same format/correlation rules with bounded payload-free metadata.
 * Duplicate contributors are counted, not retained; source paging retrieves them
 * later without adding them again to metrics. Budget exhaustion rejects, never evicts.
 */
export function scanVscodeOtel(input: ReaderInput, policy: OtelScanPolicy): Promise<ReadView> {
  return read(input, policy);
}
