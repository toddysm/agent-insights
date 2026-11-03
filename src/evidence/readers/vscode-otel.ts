/**
 * Read VS Code's extension OpenTelemetry JSON Lines export into transient evidence.
 * Only verified execution operations become events; mixed telemetry, corrupt
 * records and ambiguous identity never become invented executions or sessions.
 * No source paths, model calls, filesystem writes or captured-content logs occur.
 */
import { isDeepStrictEqual } from "node:util";
import {
  parseReadView,
  type EvidenceReader,
  type ReaderInput,
  type ReadView,
} from "../contracts.js";
import { jsonLines } from "./jsonl.js";

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
}

/** Bounded-by-category diagnostics: repeated failures do not retain payloads or one issue per record. */
class Diagnostics {
  private readonly entries = new Map<
    string,
    { code: IssueCode; message: string; count: number; line: number }
  >();

  /**
   * Accumulate a controlled message, retaining only count and first physical line.
   * @param code - Shared public issue category.
   * @param message - Application-owned description, never source text or exception text.
   * @param line - First affected one-based source line.
   */
  add(code: IssueCode, message: string, line: number): void {
    const key = `${code}:${message}`;
    const previous = this.entries.get(key);
    if (previous) previous.count++;
    else this.entries.set(key, { code, message, count: 1, line });
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
  const [seconds, nanos] = value;
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
 * @returns A candidate, or null when the operation is not a supported execution.
 */
function span(
  raw: Record<string, unknown>,
  input: ReaderInput,
  line: number,
  recordId: string,
  diagnostics: Diagnostics,
): Candidate | null {
  const attributes = raw.attributes;
  if (!object(attributes)) {
    diagnostics.add(
      "missing-field",
      "Missing or invalid span attributes",
      line,
    );
    return null;
  }
  const operation = name(attributes["gen_ai.operation.name"]);
  let kind: Span["kind"];
  if (operation === "chat" || operation === "embeddings") kind = "model-call";
  else if (operation === "execute_tool") kind = "tool-call";
  else if (operation === "invoke_agent") kind = "agent-span";
  else {
    if (operation !== "content_event")
      diagnostics.add(
        "unknown-record",
        "Unsupported execution operation",
        line,
      );
    return null;
  }
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
  if (status !== undefined && status !== 0 && status !== 1 && status !== 2)
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
  const resource =
    object(raw.resource) && object(raw.resource.attributes)
      ? raw.resource.attributes
      : {};
  const requested = name(attributes["gen_ai.request.model"]);
  const responded = name(attributes["gen_ai.response.model"]);
  const toolName = name(attributes["gen_ai.tool.name"]);
  if (kind === "tool-call" && toolName === null)
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
          : ((kind === "model-call"
              ? (responded ?? requested)
              : name(attributes["gen_ai.agent.name"])) ?? name(raw.name)),
      startedAtMs: start,
      endedAtMs: end,
      status: status === 1 ? "ok" : status === 2 ? "error" : "unknown",
      usage: usage(attributes, kind, diagnostics, line),
      trace: { id: traceId, parentId: parentTraceId },
      operation,
      spanName: name(raw.name),
      tool: { name: toolName, callId: name(attributes["gen_ai.tool.call.id"]) },
      model: { requested, responded },
      content: {
        inputMessages: content("gen_ai.input.messages"),
        outputMessages: content("gen_ai.output.messages"),
        toolArguments: content("gen_ai.tool.call.arguments"),
        toolResult: content("gen_ai.tool.call.result"),
      },
    },
    references: refs,
    identities,
    producer: name(resource["service.name"]),
    version: name(resource["service.version"]),
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
 * @returns Immutable adapter candidate with original anchors and provisional assembly
 * timestamps. RuntimeService supplies published read timing and separate capture bounds.
 * @throws Rejects on cancellation, stream errors or an internal contract violation.
 */
async function read(input: ReaderInput): Promise<ReadView> {
  const startedAtMs = Date.now();
  const diagnostics = new Diagnostics();
  const candidates = new Map<string, Candidate>();
  const operations = new Map<string, string | null>();
  const operationConflicts = new Set<string>();
  let recognized = false;
  for await (const record of jsonLines(input)) {
    if ("error" in record) {
      diagnostics.add(
        record.terminated ? "unknown-record" : "truncated-record",
        record.error === "encoding"
          ? "Invalid UTF-8 record"
          : "Malformed JSON record",
        record.line,
      );
      continue;
    }
    const raw = record.value;
    if (!object(raw)) {
      diagnostics.add(
        "unknown-record",
        "Unsupported telemetry record shape",
        record.line,
      );
      continue;
    }
    if (
      Array.isArray(raw.scopeMetrics) ||
      (milliseconds(raw.hrTime) !== null &&
        object(raw.resource) &&
        object(raw.instrumentationScope))
    ) {
      recognized = true;
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
      diagnostics.add(
        "unknown-record",
        "Unsupported telemetry record shape",
        record.line,
      );
      continue;
    }
    recognized = true;
    const operation = object(raw.attributes)
      ? name(raw.attributes["gen_ai.operation.name"])
      : null;
    const traceId = hex(raw.traceId, 32);
    const spanId = hex(raw.spanId, 16);
    // Filtering an unqualified execution must not hide a conflicting native identity.
    if (operation !== "content_event" && traceId !== null && spanId !== null) {
      const key = `${traceId}/${spanId}`;
      if (operations.has(key) && operations.get(key) !== operation) {
        operationConflicts.add(key);
        const previous = candidates.get(key);
        if (previous) previous.conflict = true;
        diagnostics.add(
          "unknown-record",
          "Conflicting execution operations share a native identity; excluded",
          record.line,
        );
      } else operations.set(key, operation);
    }
    const candidate = span(
      raw,
      input,
      record.line,
      record.recordId,
      diagnostics,
    );
    if (candidate === null) continue;
    if (operationConflicts.has(candidate.key)) candidate.conflict = true;
    const previous = candidates.get(candidate.key);
    if (previous) {
      if (
        !isDeepStrictEqual(previous.facts, candidate.facts) ||
        !isDeepStrictEqual(previous.identities, candidate.identities) ||
        previous.producer !== candidate.producer ||
        previous.version !== candidate.version
      ) {
        previous.conflict = true;
        diagnostics.add(
          "unknown-record",
          "Conflicting records share a native span identity; excluded",
          record.line,
        );
      }
      previous.references.push(...candidate.references);
    } else candidates.set(candidate.key, candidate);
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
