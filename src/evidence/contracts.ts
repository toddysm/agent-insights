/** Transient, source-linked evidence contracts; no source access, persistence or inference. */
import { z } from "zod";

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
        })
        .readonly(),
    ]),
  })
  .readonly();

/** Initial adapter targets, not a claim that readers or live captures have been validated. */
export const sourceFormatSchema = z.enum([
  "vscode-otel-jsonl",
  "vscode-chat-v3-json",
  "vscode-chat-mutations-jsonl",
]);

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

/** Recorded messages and spans only. Missing timestamps/content/usage are explicit nulls. */
export const eventSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      ...eventFields,
      kind: z.literal("message"),
      role: z.enum(["user", "assistant", "system"]),
      instructionId: id.nullable(),
      text: z.string().nullable(),
      timestampMs: milliseconds.nullable(),
    })
    .readonly(),
  z
    .strictObject({
      ...eventFields,
      kind: z.enum(["model-call", "tool-call", "agent-span"]),
      name: id.nullable(),
      startedAtMs: milliseconds.nullable(),
      endedAtMs: milliseconds.nullable(),
      status: z.enum(["ok", "error", "unknown"]),
      usage: usageSchema.nullable(),
    })
    .refine(
      (event) =>
        event.startedAtMs === null ||
        event.endedAtMs === null ||
        event.endedAtMs >= event.startedAtMs,
      { message: "Span end precedes its start" },
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
    }
    for (const issue of view.issues) {
      if (!sourceIds.has(issue.sourceId)) {
        context.addIssue({
          code: "custom",
          message: "Issue references an absent source",
        });
      }
    }
    for (const source of view.sources) {
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

/** Compare original record identities and locations without delimiter collisions. */
function referenceKey(reference: EvidenceReference): string {
  return JSON.stringify([
    reference.sourceId,
    reference.recordId,
    reference.location.kind,
    reference.location.pointer,
    reference.location.kind === "jsonl" ? reference.location.line : null,
  ]);
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
  const declaredAnchors = new Set(session.references.map(referenceKey));
  const sourcesById = new Map(
    view.sources.map((source) => [source.id, source]),
  );
  const eventOwners = new Map<string, Set<string | null>>();
  for (const event of view.events) {
    for (const reference of event.references) {
      const key = referenceKey(reference);
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
    const availability = source.coverage[metric.dimension];
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
    const key = referenceKey(reference);
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
  /** Consume only the supplied stream, honor cancellation and reject unsupported/corrupt input explicitly. */
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
