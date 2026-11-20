/**
 * Validate transient evidence and metrics independently of their source reader
 * and analysis executor. VS Code Copilot Chat is the initial source family;
 * naming a supported format here does not install a parser for it.
 *
 * Readers supply normalized records with original source anchors. Analysis can use
 * those records through a separate provider, without changing their authority or
 * conflating model judgments with captured facts. This module performs no source
 * access, persistence or model inference.
 */
import { z } from "zod";
import { sqliteKeySchema, sourceFormatSchema } from "./source-access.js";
import { resolveParentChats } from "./relationships.js";
export { sourceFormatSchema } from "./source-access.js";

/** Preserve nonempty evidence identifiers verbatim; transport limits must not truncate their contents. */
export const evidenceIdSchema = z.string().min(1);
const id = evidenceIdSchema;
const milliseconds = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pointer = z.string().regex(/^(?:\/(?:[^~]|~[01])*)?$/);

/** Coverage is scoped to the current read; absent evidence never becomes a measured zero. */
export const coverageSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete") }).readonly(),
  z.strictObject({ status: z.literal("partial"), reason: id }).readonly(),
  z.strictObject({ status: z.literal("unavailable"), reason: id }).readonly(),
]);

/** A limitation affects source integrity, specific records, linkage, or captured content, not every metric. */
export const diagnosticImpactSchema = z.strictObject({
  scope: z.enum(["source", "records", "attribution", "content", "metadata"]),
  dimensions: z.array(z.enum(["messages", "timing", "tools", "tokens"])).readonly(),
}).readonly();

/** Original record locator, independent of inferred tasks or transient event identifiers. */
export const referenceSchema = z
  .strictObject({
    sourceId: id,
    recordId: id,
    location: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("json"), pointer }).readonly(),
      z
        .strictObject({
          kind: z.literal("jsonl"),
          line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          pointer,
          byteOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
          byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .readonly(),
      z
        .strictObject({
          kind: z.literal("sqlite"),
          table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
          key: sqliteKeySchema,
          column: z
            .string()
            .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
            .nullable(),
          pointer,
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .refine(
          (location) => location.column !== null || location.pointer === "",
        )
        .readonly(),
    ]),
  })
  .readonly();

/**
 * Source-wide operation observations, not session metrics or capture completeness.
 * Execution and unclassified span counts deduplicate valid native identities; conflicting
 * identities have their own excluded bucket. Non-execution counts are physical records.
 */
export const classificationSchema = z
  .strictObject({
    executions: z
      .strictObject({
        modelCalls: tokens,
        toolCalls: tokens,
        agentSpans: tokens,
        hookExecutions: tokens,
      })
      .readonly(),
    unclassifiedSpans: z
      .strictObject({
        missingOperation: tokens,
        malformedOperation: tokens,
        unsupportedOperation: tokens,
      })
      .readonly(),
    conflictingSpans: tokens,
    nonExecutionRecords: z
      .strictObject({
        metrics: tokens,
        logs: tokens,
        contentEvents: tokens,
      })
      .readonly(),
  })
  .readonly();

/** Source metadata contains reported identity, never an identity inferred from a filesystem path. */
export const sourceSchema = z
  .strictObject({
    id,
    format: sourceFormatSchema.nullable(),
    identity: z
      .strictObject({
        producer: id.nullable(),
        version: id.nullable(),
        executionHost: z.enum(["extension", "agent-host", "unknown"]),
      })
      .readonly(),
    changedDuringRead: z.boolean().nullable(),
    classification: classificationSchema.optional(),
    /** Optional scoped-reader contract; older readers retain their source-wide coverage semantics. */
    coverageDetails: z.strictObject({
      basis: z.literal("retained-executions"),
      retainedTiming: coverageSchema,
      chatUsage: coverageSchema,
      embeddingUsage: coverageSchema,
      sessionAttribution: coverageSchema,
      history: coverageSchema,
    }).readonly().optional(),
    coverage: z
      .strictObject({
        messages: coverageSchema,
        timing: coverageSchema,
        tools: coverageSchema,
        tokens: coverageSchema,
      })
      .readonly(),
  })
  .readonly();

/** Token components explicitly state overlap; consumers must not blindly add them to totals. */
export const usageSchema = z
  .strictObject({
    basis: z.enum(["per-call", "cumulative", "unknown"]),
    input: tokens.nullable(),
    output: tokens.nullable(),
    components: z
      .array(
        z
          .strictObject({
            name: id,
            value: tokens,
            relation: z.enum([
              "subset-of-input",
              "subset-of-output",
              "additional",
              "unknown",
            ]),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();

const eventFields = {
  id,
  sessionId: id.nullable(),
  nativeId: id.nullable(),
  parentNativeId: id.nullable(),
  references: z.array(referenceSchema).min(1).readonly(),
};

/** Reported identity namespaces are not interchangeable, even when their values match. */
export const nativeIdentitySchema = z
  .strictObject({
    namespace: z.enum([
      "vscode-chat",
      "gen-ai-conversation",
      "copilot-sdk-session",
      "agent-host-session",
      "agent-host-chat",
      "agent-host-storage-session",
      "agent-host-storage-chat",
      "copilot-sdk-event",
      "copilot-sdk-agent",
      "copilot-sdk-tool-call",
      "copilot-sdk-turn",
      "copilot-sdk-api-call",
      "agent-host-turn",
    ]),
    value: id,
  })
  .readonly();

/** An explicit extension association, never a substitute for the event's own identity or membership. */
export const parentChatSchema = z.strictObject({
  namespace: z.literal("vscode-chat"),
  value: id,
  status: z.enum(["resolved", "unresolved", "ambiguous", "self", "cycle"]),
  sessionId: id.nullable(),
  reference: referenceSchema,
}).refine(
  (link) => (link.status === "resolved") === (link.sessionId !== null),
  { message: "Only resolved parent-chat relationships may name a session" },
).refine(
  (link) => link.reference.location.kind === "jsonl" &&
    link.reference.location.pointer === "/attributes/copilot_chat.parent_chat_session_id",
  { message: "Parent-chat evidence must identify the original JSONL relationship field" },
).readonly();

/** Source-reported execution content; null means absent/unsupported, never an empty substitute. */
export const executionContentSchema = z
  .strictObject({
    inputMessages: z.string().nullable(),
    outputMessages: z.string().nullable(),
    toolArguments: z.string().nullable(),
    toolResult: z.string().nullable(),
  })
  .readonly();

/** Recorded messages, executions, turn boundaries and non-additive usage; no inferred model spans. */
export const eventSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      ...eventFields,
      kind: z.literal("message"),
      role: z.enum(["user", "assistant", "system"]),
      instructionId: id.nullable(),
      text: z.string().nullable(),
      timestampMs: milliseconds.nullable(),
      /** Native submissions/response parts, not inferred steering, tasks or reconstructed model context. */
      nativeMessage: z
        .strictObject({
          eventIds: z.array(id).min(1).readonly(),
          messageId: id.nullable(),
          interactionId: id.nullable(),
          originatingMessageId: id.nullable(),
          requestId: id.nullable(),
          clientRequestId: id.nullable(),
          serviceRequestId: id.nullable(),
          turnId: id.nullable(),
          agentId: id.nullable(),
          parentAgentTaskId: id.nullable(),
          parentToolCallId: id.nullable(),
          source: z.string().nullable(),
          delivery: z.string().nullable(),
          agentMode: z.string().nullable(),
          isAutopilotContinuation: z.boolean().nullable(),
          ephemeral: z.boolean().nullable(),
          transformedContent: z.string().nullable(),
          apiCallId: id.nullable(),
          chunkIndex: tokens.nullable(),
          chunkCount: tokens.positive().nullable(),
          attribution: z.enum(["human", "system", "subagent", "assistant", "unknown"]),
          completeness: z.enum(["captured-message", "response-part", "missing-content"]),
        })
        .readonly()
        .optional(),
    })
    .readonly(),
  z
    .strictObject({
      ...eventFields,
      kind: z.enum(["model-call", "tool-call", "agent-span", "hook-execution", "assistant-turn", "usage-observation"]),
      name: id.nullable(),
      startedAtMs: milliseconds.nullable(),
      endedAtMs: milliseconds.nullable(),
      status: z.enum(["ok", "error", "unknown"]),
      usage: usageSchema.nullable(),
      /** Trace scope disambiguates native span/parent IDs; absence supports earlier readers. */
      trace: z
        .strictObject({ id: id.nullable(), parentId: id.nullable() })
        .readonly()
        .optional(),
      operation: id.optional(),
      /** Identifiers actually reported on this event, independent of resolved session membership. */
      nativeIdentities: z.array(nativeIdentitySchema).readonly().optional(),
      parentChat: parentChatSchema.optional(),
      spanName: id.nullable().optional(),
      /** Call IDs are optional reported strings, never native execution/deduplication keys; null means unavailable. */
      tool: z
        .strictObject({ name: id.nullable(), callId: id.nullable() })
        .readonly()
        .optional(),
      model: z
        .strictObject({ requested: id.nullable(), responded: id.nullable() })
        .readonly()
        .optional(),
      /** Captured hook metadata/content, never a command to execute or a replacement for span status. */
      hook: z
        .strictObject({
          type: id.nullable(),
          resultKind: id.nullable(),
          input: z.string().nullable(),
          output: z.string().nullable(),
        })
        .readonly()
        .optional(),
      content: executionContentSchema.optional(),
      /** Native graph edges are not execution parents; paired envelopes retain both namespaces. */
      nativeExecution: z.strictObject({
        eventIds: z.array(id).min(1).readonly(),
        parentEventIds: z.array(id).readonly(),
        agentId: id.nullable(),
        turnId: id.nullable(),
        toolCallId: id.nullable(),
        parentToolCallId: id.nullable(),
        parentAgentTaskId: id.nullable(),
        completeness: z.enum(["complete", "missing-start", "missing-completion"]),
        accounting: z.enum(["execution", "bridge-wrapper", "ambiguous", "boundary", "observation"]),
        cancelled: z.boolean().nullable(),
      }).readonly().optional(),
      /** These observations can overlap each other and executions; they are never additive totals. */
      observation: z.strictObject({
        scope: z.enum(["assistant-output", "turn-inclusive", "turn-direct", "session-snapshot"]),
        additive: z.literal(false),
        model: id.nullable(),
      }).readonly().optional(),
    })
    .refine(
      (event) =>
        event.startedAtMs === null ||
        event.endedAtMs === null ||
        event.endedAtMs >= event.startedAtMs,
      { message: "Span end precedes its start" },
    )
    .refine(
      (event) => event.kind !== "usage-observation" ||
        (event.observation !== undefined && event.usage !== null && event.usage.basis !== "per-call"),
      { message: "Usage observations must state their non-additive scope" },
    )
    .refine(
      (event) => !event.parentChat || event.references.some((anchor) => {
        const ref = event.parentChat?.reference;
        return ref !== undefined &&
          anchor.sourceId === ref.sourceId && anchor.recordId === ref.recordId &&
          anchor.location.kind === "jsonl" && ref.location.kind === "jsonl" &&
          anchor.location.line === ref.location.line;
      }),
      { message: "Parent-chat field evidence belongs to an unrelated record or source" },
    )
    .readonly(),
]);

/** One bounded read generation. Source changes and unsupported/incomplete data remain visible. */
export const readViewSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id,
    startedAtMs: milliseconds,
    finishedAtMs: milliseconds,
    sources: z.array(sourceSchema).min(1).readonly(),
    sessions: z
      .array(
        z
          .strictObject({
            id,
            nativeId: id.nullable(),
            /** A reported detached-session parent, not an inferred task or flattened session. */
            parentNativeId: id.nullable().optional(),
            /** Host relationships remain distinct from SDK event/agent identities and are not flattened. */
            nativeSession: z
              .strictObject({
                parentChatId: id.nullable(),
                originSessionId: id.nullable(),
                archived: z.boolean(),
                historyScope: z.literal("retained-native-log"),
              })
              .readonly()
              .optional(),
            nativeIdentities: z
              .array(nativeIdentitySchema)
              .readonly()
              .optional(),
            sourceIds: z.array(id).min(1).readonly(),
            references: z.array(referenceSchema).min(1).readonly(),
          })
          .readonly(),
      )
      .readonly(),
    events: z.array(eventSchema).readonly(),
    issues: z
      .array(
        z
          .strictObject({
            sourceId: id,
            code: z.enum([
              "source-changed",
              "truncated-record",
              "unsupported-schema",
              "missing-field",
              "ambiguous-session",
              "unreadable-source",
              "unknown-record",
            ]),
            message: id,
            /** False marks an informational notice; omitted/true retains legacy limiting semantics. */
            affectsCoverage: z.boolean().optional(),
            impact: diagnosticImpactSchema.optional(),
            severity: z.enum(["info", "warning", "error"]).optional(),
            /** Optional structured diagnostics; earlier readers may supply only a message. */
            count: tokens.positive().optional(),
            references: z.array(referenceSchema).min(1).readonly().optional(),
          })
          .readonly(),
      )
      .readonly(),
  })
  .superRefine((view, context) => {
    const sourceIds = new Set(view.sources.map((source) => source.id));
    const sessionsById = new Map(
      view.sessions.map((session) => [session.id, session]),
    );
    const changedSourceIds = new Set(
      view.issues
        .filter((issue) => issue.code === "source-changed")
        .map((issue) => issue.sourceId),
    );
    if (view.finishedAtMs < view.startedAtMs) {
      context.addIssue({
        code: "custom",
        message: "Read completion precedes its start",
      });
    }
    for (const collection of [view.sources, view.sessions, view.events]) {
      if (
        new Set(collection.map((entry) => entry.id)).size !== collection.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Duplicate identity within a read collection",
        });
      }
    }
    for (const session of view.sessions) {
      if (session.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
        context.addIssue({
          code: "custom",
          message: "Session references an absent source",
        });
      }
      if (
        session.references.some(
          (ref) => !session.sourceIds.includes(ref.sourceId),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Session evidence references an unrelated source",
        });
      }
    }
    for (const event of view.events) {
      if (event.sessionId !== null && !sessionsById.has(event.sessionId)) {
        context.addIssue({
          code: "custom",
          message: "Event references an absent session",
        });
      }
      const session =
        event.sessionId === null
          ? undefined
          : sessionsById.get(event.sessionId);
      if (
        event.references.some(
          (ref) =>
            !sourceIds.has(ref.sourceId) ||
            (session !== undefined &&
              !session.sourceIds.includes(ref.sourceId)),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Event references an absent or unrelated source",
        });
      }
      if (event.kind !== "message" && event.parentChat) {
        const ref = event.parentChat.reference;
        if (
          view.sources.find((source) => source.id === ref.sourceId)?.format !== "vscode-otel-jsonl"
        )
          context.addIssue({ code: "custom", message: "Parent-chat field evidence belongs to an unrelated record or source" });
      }
    }
    const parentChats = resolveParentChats(view.events, view.sessions);
    for (const event of view.events) {
      if (event.kind === "message" || !event.parentChat) continue;
      const expected = parentChats.get(event.id);
      if (expected?.status !== event.parentChat.status || expected.sessionId !== event.parentChat.sessionId)
        context.addIssue({ code: "custom", message: "Parent-chat resolution disagrees with observed same-source session identities" });
    }
    for (const issue of view.issues) {
      if (!sourceIds.has(issue.sourceId)) {
        context.addIssue({
          code: "custom",
          message: "Issue references an absent source",
        });
      }
      if (
        issue.references?.some(
          (ref) =>
            ref.sourceId !== issue.sourceId || !sourceIds.has(ref.sourceId),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Issue references an absent or unrelated source",
        });
      }
      if (issue.impact?.scope === "records" && !issue.references?.length)
        context.addIssue({ code: "custom", message: "Record-scoped diagnostics require original references" });
      if (
        (issue.code === "source-changed" || issue.code === "unreadable-source") &&
        (issue.affectsCoverage === false || (issue.impact !== undefined &&
          (issue.impact.scope !== "source" || ["messages", "timing", "tools", "tokens"].some(
            (dimension) => !issue.impact?.dimensions.some((value) => value === dimension),
          ))))
      )
        context.addIssue({ code: "custom", message: "Source integrity failures must limit every dimension" });
    }
    for (const source of view.sources) {
      if (source.coverageDetails && (
        source.format !== "vscode-otel-jsonl" || source.coverageDetails.history.status === "complete"
      ))
        context.addIssue({ code: "custom", message: "Scoped extension coverage cannot certify complete source/session history" });
      if (
        source.format === null &&
        Object.values(source.coverage).some(
          (coverage) => coverage.status !== "unavailable",
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Unknown source format cannot claim available coverage",
        });
      }
      const hasChangeIssue = changedSourceIds.has(source.id);
      if (hasChangeIssue !== (source.changedDuringRead === true)) {
        context.addIssue({
          code: "custom",
          message: "Source change flag and issue disagree",
        });
      }
      if (
        source.changedDuringRead === true &&
        Object.values(source.coverage).some(
          (coverage) => coverage.status === "complete",
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Changed source requires reduced coverage",
        });
      }
    }
  })
  .readonly();

/** Immutable normalized facts for one read generation; they are not an application archive. */
export type ReadView = z.infer<typeof readViewSchema>;
/** Supported source family identifier for a separately implemented reader. */
export type SourceFormat = z.infer<typeof sourceFormatSchema>;
/** An original-source reference suitable for metric-to-record drill-down. */
export type EvidenceReference = z.infer<typeof referenceSchema>;

/** Calculator output; provenance validates shape and scope, not the correctness of arithmetic. */
export const metricSchema = z
  .strictObject({
    readId: id,
    sessionId: id,
    key: id,
    basis: z.literal("calculated"),
    dimension: z.enum(["messages", "timing", "tools", "tokens"]),
    unit: z.enum(["milliseconds", "tokens", "count"]),
    value: milliseconds.nullable(),
    coverage: coverageSchema,
    contributors: z.array(referenceSchema).readonly(),
  })
  .superRefine((metric, context) => {
    if (metric.coverage.status === "unavailable") {
      if (metric.value !== null)
        context.addIssue({
          code: "custom",
          message: "Unavailable is not a numeric value",
        });
    } else if (metric.value === null || metric.contributors.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Available metrics require a value and source contributors",
      });
    }
    if (
      metric.value !== null &&
      metric.unit !== "milliseconds" &&
      !Number.isSafeInteger(metric.value)
    ) {
      context.addIssue({
        code: "custom",
        message: "Counts and tokens must be safe integers",
      });
    }
  })
  .readonly();

/** Derived numeric result whose contributors remain inspectable in the same read generation. */
export type Metric = z.infer<typeof metricSchema>;

/** Validate an untrusted adapter result; throws ZodError rather than repairing invalid evidence. */
export function parseReadView(input: unknown): ReadView {
  return readViewSchema.parse(input);
}

/** Compare original locators, including SQLite fields and captured revisions, without delimiter collisions. */
export function evidenceReferenceKey(reference: EvidenceReference): string {
  const location = reference.location;
  return JSON.stringify([
    reference.sourceId,
    reference.recordId,
    location.kind,
    location.pointer,
    location.kind === "jsonl" ? location.line : null,
    ...(location.kind === "sqlite"
      ? [location.table, location.key, location.column, location.fingerprint]
      : []),
  ]);
}

/** Group field pointers within the same physical record without merging replayed lines or source revisions. */
export function evidenceRecordKey(reference: EvidenceReference): string {
  return evidenceReferenceKey({ ...reference, location: { ...reference.location, pointer: "" } });
}

/** Per-dimension lookup state owned by one calculation, never persisted or shared across reads. */
interface CoverageImpacts {
  readonly source: Set<string>;
  readonly records: Map<string, Set<string>>;
  readonly unavailable: Set<string>;
}

/**
 * Index qualified-reader diagnostics and retained field availability once per calculation.
 * The returned lookup costs only the selected references, not all diagnostic anchors.
 * Legacy source-wide semantics, incomplete diagnostic anchors and integrity failures remain
 * conservative. Availability describes retained fields, not capture or session membership.
 */
export function createCoverageLookup(view: ReadView): (
  source: ReadView["sources"][number],
  dimension: Metric["dimension"],
  references: readonly EvidenceReference[],
) => Metric["coverage"] {
  const dimensions = ["messages", "timing", "tools", "tokens"] as const;
  const index = new Map<string, Map<Metric["dimension"], CoverageImpacts>>();
  for (const source of view.sources) {
    if (!source.coverageDetails) continue;
    index.set(source.id, new Map(dimensions.map((dimension) => [
      dimension, {
        source: new Set<string>(source.changedDuringRead ? ["Source changed during read"] : []),
        records: new Map<string, Set<string>>(),
        unavailable: new Set<string>(),
      },
    ])));
  }
  /** Deduplicate controlled reasons for one physical record, independent of its field pointers. */
  const limitRecord = (impact: CoverageImpacts, key: string, reason: string): void => {
    const reasons = impact.records.get(key) ?? new Set<string>();
    reasons.add(reason);
    impact.records.set(key, reasons);
  };
  for (const issue of view.issues) {
    const source = index.get(issue.sourceId);
    if (!source || issue.affectsCoverage === false) continue;
    if (issue.impact && !["source", "records"].includes(issue.impact.scope)) continue;
    const references = issue.references ?? [];
    for (const dimension of issue.impact?.dimensions ?? dimensions) {
      const impact = source.get(dimension)!;
      if (issue.impact?.scope !== "records" ||
          (issue.count !== undefined && issue.count > references.length)) {
        impact.source.add(issue.message);
      } else {
        for (const reference of references)
          limitRecord(impact, evidenceRecordKey(reference), issue.message);
      }
    }
  }
  for (const event of view.events) {
    for (const reference of event.references) {
      const source = index.get(reference.sourceId);
      if (!source) continue;
      const key = evidenceRecordKey(reference);
      const timing = source.get("timing")!;
      const start = event.kind === "message" ? event.timestampMs : event.startedAtMs;
      const end = event.kind === "message" ? event.timestampMs : event.endedAtMs;
      if (start === null || end === null) {
        limitRecord(timing, key, "Some selected records have missing timing boundaries.");
        if (start === null && end === null) timing.unavailable.add(key);
      }
      const tokens = source.get("tokens")!;
      const usage = event.kind === "message" ? null : event.usage;
      if (usage?.input == null || usage.output === null) {
        limitRecord(tokens, key, "Some selected records have missing reported token fields.");
        if (usage?.input == null && usage?.output == null && !usage?.components.length)
          tokens.unavailable.add(key);
      }
    }
  }
  return (source, dimension, references) => {
    const coverage = source.coverage[dimension];
    if (!source.coverageDetails || coverage.status === "unavailable") return coverage;
    const impact = index.get(source.id)?.get(dimension);
    if (!impact) throw new Error("Scoped coverage requires a source in the current read");
    const reasons = new Set(impact.source);
    let selected = 0;
    let unavailable = 0;
    for (const reference of references) {
      if (reference.sourceId !== source.id) continue;
      const key = evidenceRecordKey(reference);
      selected++;
      if (impact.unavailable.has(key)) unavailable++;
      for (const reason of impact.records.get(key) ?? []) reasons.add(reason);
    }
    return reasons.size
      ? {
          status: selected > 0 && unavailable === selected ? "unavailable" : "partial",
          reason: [...reasons].join(" "),
        }
      : { status: "complete" };
  };
}

/** Reject stale, unavailable or misattributed evidence; zero anchors require complete relevant capture. */
export function parseMetric(input: unknown, view: ReadView): Metric {
  const metric = metricSchema.parse(input);
  const session = view.sessions.find(
    (candidate) => candidate.id === metric.sessionId,
  );
  if (metric.readId !== view.id || session === undefined) {
    throw new Error(
      "Metric belongs to an unavailable read generation or session",
    );
  }
  const declaredAnchors = new Set(session.references.map(evidenceReferenceKey));
  const sourcesById = new Map(
    view.sources.map((source) => [source.id, source]),
  );
  const coverageForReferences = createCoverageLookup(view);
  const availabilityBySource = new Map(view.sources.map((source) => [
    source.id, coverageForReferences(source, metric.dimension, metric.contributors),
  ]));
  const eventOwners = new Map<string, Set<string | null>>();
  for (const event of view.events) {
    for (const reference of event.references) {
      const key = evidenceReferenceKey(reference);
      const owners = eventOwners.get(key) ?? new Set<string | null>();
      owners.add(event.sessionId);
      eventOwners.set(key, owners);
    }
  }
  for (const reference of metric.contributors) {
    const source = sourcesById.get(reference.sourceId);
    if (
      source === undefined ||
      !session.sourceIds.includes(reference.sourceId)
    ) {
      throw new Error("Metric contributor belongs to an unrelated source");
    }
    const availability = availabilityBySource.get(source.id)!;
    if (metric.value !== null && availability.status === "unavailable") {
      throw new Error(`Metric evidence is unavailable for ${metric.dimension}`);
    }
    if (
      metric.coverage.status === "complete" &&
      availability.status !== "complete"
    ) {
      throw new Error(
        "Complete metrics require complete contributing coverage",
      );
    }
    const key = evidenceReferenceKey(reference);
    const owners = eventOwners.get(key);
    if (owners !== undefined) {
      if (owners.size !== 1 || !owners.has(session.id)) {
        throw new Error(
          "Metric contributor belongs to another or ambiguous session",
        );
      }
    } else if (
      !declaredAnchors.has(key) ||
      (metric.value !== 0 && metric.coverage.status !== "unavailable")
    ) {
      throw new Error(
        "Metric requires known event evidence or a declared zero/unavailable anchor",
      );
    } else if (metric.value !== null && availability.status !== "complete") {
      throw new Error(
        "A zero-valued anchor requires complete evidence for its dimension",
      );
    }
  }
  return metric;
}

/** Borrowed byte stream supplied by the approved source-access boundary; readers cannot select paths. */
export interface ReaderInput {
  readonly readId: string;
  readonly sourceId: string;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
}

/** Adapter extension point: no source writes, persistence, model calls or hidden fallback formats. */
export interface EvidenceReader {
  readonly format: SourceFormat;
  /**
   * Parse borrowed bytes, honor cancellation and report unsupported/corrupt input.
   * @param input - Current identity, borrowed stream and cancellation; no filesystem capture bounds.
   * @returns Adapter candidate with provisional timestamps. The runtime replaces
   * read timing before publication; only its readTiming.input* fields identify
   * physical source observation. Never treat adapter timestamps as that interval.
   */
  read(input: ReaderInput): Promise<ReadView>;
}

/** Find exactly one registered adapter; missing or duplicate registrations are explicit errors. */
export function selectReader(
  readers: readonly EvidenceReader[],
  format: SourceFormat,
): EvidenceReader {
  const matches = readers.filter((reader) => reader.format === format);
  if (matches.length !== 1)
    throw new Error(
      `Expected one reader for ${format}; found ${matches.length}`,
    );
  const reader = matches[0];
  if (reader === undefined)
    throw new Error("Reader registration is unavailable");
  return reader;
}
