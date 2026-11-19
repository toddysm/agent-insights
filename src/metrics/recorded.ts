/**
 * Calculate recorded metrics from one transient read without source access or inference.
 * Native snapshots remain separate non-additive observations; scopes and original
 * contributors accompany every number. Nothing here persists evidence or results.
 */
import { isDeepStrictEqual } from "node:util";
import { associatedWithSession } from "../evidence/relationships.js";
import {
  evidenceReferenceKey as referenceKey,
  metricSchema,
  type EvidenceReference,
  type Metric,
  type ReadView,
} from "../evidence/contracts.js";

/** Immutable normalized event, including messages and non-additive native observations. */
type Event = ReadView["events"][number];
/** Execution-shaped records also include boundaries/observations, which are not active spans. */
type Execution = Exclude<Event, { kind: "message" }>;
/** Current-read coverage; partial and unavailable always carry a reason. */
type Coverage = Metric["coverage"];

/** An explicit session or evidence-attributed subset, never an inferred task boundary. */
export interface MetricScope {
  readonly sessionId: string;
  readonly kind: "session" | "events";
  readonly eventIds: readonly string[];
}

/** Numeric contract plus its definition and exact evidence selection; unavailable is null, not zero. */
export interface RecordedMetric {
  readonly metric: Metric;
  /** Exact records used for the value or unavailable explanation, including replays; source-only witnesses add none. */
  readonly contributorEventIds: readonly string[];
  readonly scope: MetricScope;
  readonly definition: string;
}

/** Excluded replays retain their IDs/locators together without acquiring session ownership. */
export interface MetricExclusion {
  readonly eventIds: readonly string[];
  readonly reason:
    | "ambiguous-attribution"
    | "associated-only"
    | "conflicting-replay"
    | "bridge-wrapper"
    | "ambiguous-accounting";
  readonly references: readonly EvidenceReference[];
}

/** Reported component totals are separate; even "additional" components are not folded into input/output. */
export interface TokenComponent {
  readonly name: string;
  readonly relation: NonNullable<
    Execution["usage"]
  >["components"][number]["relation"];
  readonly tokens: RecordedMetric;
}

/** A native/unknown/cumulative usage report, not another additive ledger entry. */
export interface UsageObservation {
  readonly eventIds: readonly string[];
  readonly basis: NonNullable<Execution["usage"]>["basis"];
  readonly accountingScope:
    NonNullable<Execution["observation"]>["scope"] | "reported-only";
  /** Explicit observation or responded/requested model identifier, never an operation name. */
  readonly model: string | null;
  readonly input: RecordedMetric;
  readonly output: RecordedMetric;
  readonly components: readonly TokenComponent[];
}

/** Pure calculator output; read bounds are observation times, not session activity boundaries. */
export interface RecordedMetrics {
  readonly readId: string;
  readonly readBounds: {
    readonly startedAtMs: number;
    readonly finishedAtMs: number;
  };
  readonly scope: MetricScope;
  readonly timing: {
    readonly observedStart: RecordedMetric;
    readonly observedEnd: RecordedMetric;
    readonly elapsed: RecordedMetric;
    readonly agentActivity: RecordedMetric;
    readonly cumulativeSpanDuration: RecordedMetric;
    readonly unobservedGaps: RecordedMetric;
  };
  readonly tools: {
    readonly calls: RecordedMetric;
    readonly identities: readonly {
      readonly name: string | null;
      readonly callIds: readonly string[];
      readonly calls: RecordedMetric;
    }[];
  };
  readonly tokens: {
    readonly input: RecordedMetric;
    readonly output: RecordedMetric;
    readonly components: readonly TokenComponent[];
    readonly observations: readonly UsageObservation[];
  };
  readonly exclusions: readonly MetricExclusion[];
}

/** Deduplicated event with every replay's current-read event ID and original locator. */
interface RecordGroup {
  readonly event: Event;
  readonly eventIds: string[];
  readonly references: EvidenceReference[];
  conflict: boolean;
}

/** A numeric contribution keeps its event group so coverage and provenance follow arithmetic. */
interface Contribution {
  readonly value: number;
  readonly group: RecordGroup;
}

/** Keep original references once; byte-window hints do not turn one source record into two. */
function uniqueReferences(
  references: readonly EvidenceReference[],
): EvidenceReference[] {
  return [
    ...new Map(
      references.map((reference) => [referenceKey(reference), reference]),
    ).values(),
  ];
}

/** Append to a calculator-owned list without the VM argument limit on large evidence arrays. */
function appendReferences(
  target: EvidenceReference[],
  references: readonly EvidenceReference[],
): void {
  for (const reference of references) target.push(reference);
}

/** Native IDs are comparable only within source, kind, trace and native agent/session namespaces. */
function eventKey(event: Event): string {
  if (event.nativeId === null)
    return JSON.stringify([
      event.kind,
      event.references.map(referenceKey).sort(),
    ]);
  if (event.kind === "message")
    return JSON.stringify([
      event.kind,
      [
        ...new Set(event.references.map((reference) => reference.sourceId)),
      ].sort(),
      event.nativeId,
    ]);
  const nativeScope = event.nativeIdentities
    ?.filter(
      (identity) =>
        identity.namespace === "copilot-sdk-session" ||
        identity.namespace === "copilot-sdk-agent",
    )
    .map((identity) => [identity.namespace, identity.value])
    .sort();
  return JSON.stringify([
    event.kind,
    event.trace?.id ||
    nativeScope?.some(([namespace]) => namespace === "copilot-sdk-session")
      ? null
      : [
          ...new Set(event.references.map((reference) => reference.sourceId)),
        ].sort(),
    event.trace?.id ?? null,
    event.nativeId,
    event.nativeExecution?.agentId ?? null,
    nativeScope,
    event.observation ?? null,
  ]);
}

/** Compare semantic payloads, excluding read-local IDs and physical replay locations. */
function sameEvent(left: Event, right: Event): boolean {
  return isDeepStrictEqual(
    { ...left, id: null, references: [] },
    { ...right, id: null, references: [] },
  );
}

/** Only recorded execution intervals establish activity; turns are boundaries, not model spans. */
function active(event: Event): event is Execution {
  return (
    event.kind !== "message" &&
    event.kind !== "assistant-turn" &&
    event.kind !== "usage-observation"
  );
}

/** Sum without publishing rounded unsafe totals; null signals arithmetic outside the contract. */
function sum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) return null;
    total += value;
  }
  return total;
}

/** Merge nested/parallel intervals without counting overlap twice; inputs are validated milliseconds. */
function intervalUnion(
  intervals: readonly (readonly [number, number])[],
): number | null {
  const ordered = [...intervals].sort(([a], [b]) => a - b);
  const first = ordered[0];
  if (!first) return 0;
  let start = first[0];
  let end = first[1];
  const lengths: number[] = [];
  for (const [nextStart, finish] of ordered) {
    if (nextStart <= end) end = Math.max(end, finish);
    else {
      lengths.push(end - start);
      start = nextStart;
      end = finish;
    }
  }
  lengths.push(end - start);
  const total = sum(lengths);
  // Bound floating-point roundoff by the mathematically enclosing interval.
  return total === null ? null : Math.min(total, end - first[0]);
}

/**
 * Calculate recorded timing, tools and usage for a validated current read.
 * Omitted eventIds selects the session; supplied IDs select evidence, not a time slice.
 * Replays are deduplicated across the whole session before selecting a subset. Shared,
 * conflicting and unresolved evidence is excluded explicitly, never assigned by proximity.
 * @throws Error for an absent session or unknown/foreign event IDs. Numeric overflow
 * produces an unavailable metric with a reason; input objects are never changed.
 */
export function calculateRecordedMetrics(
  view: ReadView,
  selection: {
    readonly sessionId: string;
    readonly eventIds?: readonly string[];
  },
): RecordedMetrics {
  const session = view.sessions.find(
    (candidate) => candidate.id === selection.sessionId,
  );
  if (!session)
    throw new Error("Metrics require a session in the current read");
  const byId = new Map(view.events.map((event) => [event.id, event]));
  const requested =
    selection.eventIds === undefined ? null : new Set(selection.eventIds);
  for (const id of requested ?? []) {
    const event = byId.get(id);
    if (
      !event ||
      (event.sessionId !== session.id &&
        !(
          event.sessionId === null &&
          event.references.some((ref) =>
            session.sourceIds.includes(ref.sourceId),
          )
        ))
    )
      throw new Error("Metric selection contains an unknown or foreign event");
  }
  const scope: MetricScope = Object.freeze({
    sessionId: session.id,
    kind: requested === null ? "session" : "events",
    eventIds: Object.freeze(
      requested === null
        ? view.events
            .filter((event) => event.sessionId === session.id)
            .map((event) => event.id)
        : [...requested],
    ),
  });
  const owners = new Map<string, Set<string | null>>();
  const foreignAnchors = new Set(
    view.sessions
      .filter((candidate) => candidate.id !== session.id)
      .flatMap((candidate) => candidate.references.map(referenceKey)),
  );
  for (const event of view.events)
    for (const reference of event.references) {
      const key = referenceKey(reference);
      const found = owners.get(key) ?? new Set<string | null>();
      found.add(event.sessionId);
      owners.set(key, found);
    }
  const grouped = new Map<string, RecordGroup>();
  const byReferences = new Map<string, RecordGroup>();
  const exclusions: MetricExclusion[] = [];
  for (const event of view.events) {
    if (
      event.sessionId !== session.id &&
      !(
        event.sessionId === null &&
        event.references.some((ref) => session.sourceIds.includes(ref.sourceId))
      )
    )
      continue;
    const key = JSON.stringify([event.sessionId, eventKey(event)]);
    const locatorKey = JSON.stringify([
      event.sessionId,
      event.kind,
      [...new Set(event.references.map(referenceKey))].sort(),
    ]);
    const byIdentity = grouped.get(key);
    const byLocator = byReferences.get(locatorKey);
    const group = byIdentity ?? byLocator;
    if (byIdentity && byLocator && byIdentity !== byLocator) {
      byIdentity.conflict = true;
      byLocator.conflict = true;
    }
    if (group) {
      group.eventIds.push(event.id);
      appendReferences(group.references, event.references);
      group.conflict ||= !sameEvent(group.event, event);
      grouped.set(key, group);
      byReferences.set(locatorKey, group);
    } else {
      const created = {
        event,
        eventIds: [event.id],
        references: [...event.references],
        conflict: false,
      };
      grouped.set(key, created);
      byReferences.set(locatorKey, created);
    }
  }
  const groups: RecordGroup[] = [];
  for (const group of new Set(grouped.values())) {
    if (requested !== null && !group.eventIds.some((id) => requested.has(id)))
      continue;
    const reason =
      group.event.sessionId === null
        ? associatedWithSession(group.event, session.id)
          ? "associated-only"
          : "ambiguous-attribution"
        : group.conflict
          ? "conflicting-replay"
          : group.references.some((reference) => {
                const found = owners.get(referenceKey(reference));
                return found && (found.size !== 1 || !found.has(session.id));
              })
            ? "ambiguous-attribution"
            : group.event.kind !== "message" &&
                group.event.nativeExecution?.accounting === "bridge-wrapper"
              ? "bridge-wrapper"
              : group.event.kind !== "message" &&
                  group.event.nativeExecution?.accounting === "ambiguous"
                ? "ambiguous-accounting"
                : null;
    if (reason)
      exclusions.push({
        eventIds: group.eventIds,
        reason,
        references: uniqueReferences(group.references),
      });
    else groups.push(group);
  }
  const sources = new Map(view.sources.map((source) => [source.id, source]));

  /** Emit dimension-available, uniquely owned references and exact contributing group IDs; missing numbers never acquire zeros. */
  const measurement = (
    key: string,
    dimension: Metric["dimension"],
    unit: Metric["unit"],
    value: number | null,
    contributors: readonly RecordGroup[],
    definition: string,
    reasons: readonly string[] = [],
    metricScope: MetricScope = scope,
    allowEmptyZero = false,
  ): RecordedMetric => {
    const original = uniqueReferences(
      contributors.flatMap((group) => group.references),
    );
    const references =
      value === null
        ? original
        : original.filter(
            (ref) =>
              sources.get(ref.sourceId)?.coverage[dimension].status !==
              "unavailable",
          );
    const coverageReasons = new Set(reasons);
    const sessionSources = view.sources.filter((source) =>
      session.sourceIds.includes(source.id),
    );
    for (const source of sessionSources) {
      const coverage = source.coverage[dimension];
      if (coverage.status !== "complete") coverageReasons.add(coverage.reason);
    }
    if (exclusions.some((entry) => entry.reason !== "bridge-wrapper"))
      coverageReasons.add(
        "Shared, conflicting or ambiguous evidence was excluded.",
      );
    if (
      allowEmptyZero &&
      references.length === 0 &&
      value === 0 &&
      metricScope.kind === "session" &&
      sessionSources.length > 0 &&
      coverageReasons.size === 0
    ) {
      appendReferences(
        references,
        uniqueReferences(
          session.references.filter(
            (ref) =>
              sources.get(ref.sourceId)?.coverage[dimension].status ===
                "complete" &&
              (!owners.has(referenceKey(ref)) ||
                (owners.get(referenceKey(ref))?.size === 1 &&
                  owners.get(referenceKey(ref))?.has(session.id))) &&
              !foreignAnchors.has(referenceKey(ref)),
          ),
        ),
      );
    }
    let coverage: Coverage;
    if (value === null || references.length === 0) {
      value = null;
      coverage = {
        status: "unavailable",
        reason:
          reasons.join(" ") ||
          "No attributable measurement is available for this metric.",
      };
      if (references.length === 0 && metricScope.kind === "session")
        appendReferences(
          references,
          uniqueReferences(
            session.references.filter(
              (ref) =>
                !owners.has(referenceKey(ref)) &&
                !foreignAnchors.has(referenceKey(ref)),
            ),
          ),
        );
    } else
      coverage = coverageReasons.size
        ? { status: "partial", reason: [...coverageReasons].join(" ") }
        : { status: "complete" };
    return Object.freeze({
      metric: metricSchema.parse({
        readId: view.id,
        sessionId: session.id,
        key,
        basis: "calculated",
        dimension,
        unit,
        value,
        coverage,
        contributors: references,
      }),
      contributorEventIds: Object.freeze([
        ...new Set(contributors.flatMap((group) => group.eventIds)),
      ]),
      scope: metricScope,
      definition,
    });
  };

  /** Use only groups with at least one source that supports the relevant evidence dimension. */
  const available = (
    group: RecordGroup,
    dimension: Metric["dimension"],
  ): boolean =>
    group.references.some(
      (ref) =>
        sources.get(ref.sourceId)?.coverage[dimension].status !== "unavailable",
    );

  const boundaries: Contribution[] = [];
  const spans: { group: RecordGroup; start: number; end: number }[] = [];
  let missingTiming = false;
  for (const group of groups) {
    const event = group.event;
    if (event.kind === "usage-observation") continue;
    if (!available(group, "timing")) {
      missingTiming = true;
      continue;
    }
    if (event.kind === "message") {
      if (event.timestampMs !== null)
        boundaries.push({ value: event.timestampMs, group });
      else missingTiming = true;
    } else {
      if (event.startedAtMs !== null)
        boundaries.push({ value: event.startedAtMs, group });
      if (event.endedAtMs !== null)
        boundaries.push({ value: event.endedAtMs, group });
      if (event.startedAtMs === null || event.endedAtMs === null)
        missingTiming = true;
      else if (active(event))
        spans.push({ group, start: event.startedAtMs, end: event.endedAtMs });
    }
  }
  const times = boundaries.map((boundary) => boundary.value);
  const start = times.length ? times.reduce((a, b) => Math.min(a, b)) : null;
  const end = times.length ? times.reduce((a, b) => Math.max(a, b)) : null;
  const elapsed =
    start !== null && end !== null && times.length >= 2 ? end - start : null;
  const union = spans.length
    ? intervalUnion(spans.map((span) => [span.start, span.end]))
    : null;
  const cumulative = spans.length
    ? sum(spans.map((span) => span.end - span.start))
    : null;
  const timingReasons = missingTiming
    ? ["Some selected records have missing timing boundaries."]
    : [];
  const timingGroups = boundaries.map((boundary) => boundary.group);
  const timing = Object.freeze({
    observedStart: measurement(
      "observed-start",
      "timing",
      "milliseconds",
      start,
      boundaries
        .filter((boundary) => boundary.value === start)
        .map((boundary) => boundary.group),
      "Earliest recorded timestamp in the selection, in Unix milliseconds.",
      timingReasons,
    ),
    observedEnd: measurement(
      "observed-end",
      "timing",
      "milliseconds",
      end,
      boundaries
        .filter((boundary) => boundary.value === end)
        .map((boundary) => boundary.group),
      "Latest recorded timestamp in the selection, in Unix milliseconds.",
      timingReasons,
    ),
    elapsed: measurement(
      "observed-elapsed",
      "timing",
      "milliseconds",
      elapsed,
      timingGroups,
      "Latest minus earliest observed boundary; not read duration or inferred session lifetime.",
      timingReasons,
    ),
    agentActivity: measurement(
      "recorded-agent-activity",
      "timing",
      "milliseconds",
      union,
      spans.map((span) => span.group),
      "Union of complete recorded model, tool, agent and hook intervals; turns are not active spans.",
      timingReasons,
    ),
    cumulativeSpanDuration: measurement(
      "cumulative-span-duration",
      "timing",
      "milliseconds",
      cumulative,
      spans.map((span) => span.group),
      "Sum of distinct complete execution intervals; intentionally includes nested and parallel work.",
      cumulative === null && spans.length
        ? [...timingReasons, "Duration sum exceeds the safe numeric range."]
        : timingReasons,
    ),
    unobservedGaps: measurement(
      "unobserved-gaps",
      "timing",
      "milliseconds",
      elapsed !== null && union !== null ? elapsed - union : null,
      [...timingGroups, ...spans.map((span) => span.group)],
      "Observed elapsed minus recorded interval-union activity; not human typing or true idle time.",
      timingReasons,
    ),
  });

  const toolCandidates = groups.filter(
    (group) => group.event.kind === "tool-call",
  );
  const tools = toolCandidates.filter((group) => available(group, "tools"));
  const toolReasons =
    tools.length < toolCandidates.length
      ? ["Some selected tool records have unavailable tool coverage."]
      : [];
  const toolGroups = new Map<string | null, RecordGroup[]>();
  for (const group of tools) {
    const event = group.event;
    if (event.kind !== "tool-call") continue;
    const name = event.tool?.name ?? event.name;
    const entries = toolGroups.get(name) ?? [];
    entries.push(group);
    toolGroups.set(name, entries);
  }
  const toolResults = Object.freeze({
    calls: measurement(
      "tool-calls",
      "tools",
      "count",
      tools.length,
      tools,
      "Distinct recorded tool executions, including incomplete calls; bridge wrappers are excluded.",
      toolReasons,
      scope,
      true,
    ),
    identities: Object.freeze(
      [...toolGroups].map(([name, entries]) =>
        Object.freeze({
          name,
          callIds: Object.freeze([
            ...new Set(
              entries.flatMap(({ event }) =>
                event.kind !== "message"
                  ? [
                      event.tool?.callId ??
                        event.nativeExecution?.toolCallId ??
                        null,
                    ].filter((id) => id !== null)
                  : [],
              ),
            ),
          ]),
          calls: measurement(
            `tool-calls:${JSON.stringify(name)}`,
            "tools",
            "count",
            entries.length,
            entries,
            "Distinct tool executions with this reported name; null names remain unknown.",
            toolReasons,
          ),
        }),
      ),
    ),
  });

  const models = groups.filter((group) => group.event.kind === "model-call");
  const additive = models.filter(
    (group) =>
      group.event.kind !== "message" &&
      group.event.usage?.basis === "per-call" &&
      available(group, "tokens"),
  );

  /** Aggregate a reported field only; partial/missing contributors are never silently zero-filled. */
  const tokenTotal = (
    key: string,
    entries: readonly RecordGroup[],
    values: readonly Contribution[],
    expected: number,
    definition: string,
    metricScope: MetricScope = scope,
  ): RecordedMetric => {
    const total = values.length ? sum(values.map((item) => item.value)) : null;
    const reasons =
      values.length < expected
        ? [
            "Some selected records do not report an additive measurement for this field.",
          ]
        : [];
    if (values.length && total === null)
      reasons.push("Token sum exceeds the safe integer range.");
    return measurement(
      key,
      "tokens",
      "tokens",
      total,
      total === null ? entries : values.map((item) => item.group),
      definition,
      reasons.length
        ? reasons
        : entries.length
          ? []
          : [
              "No per-call model usage is available; native observations are separate.",
            ],
      metricScope,
    );
  };

  /** Preserve component overlap categories without adding them to input/output or to each other. */
  const components = (
    entries: readonly RecordGroup[],
    metricScope: MetricScope,
  ): readonly TokenComponent[] => {
    const categories = new Map<
      string,
      {
        name: string;
        relation: TokenComponent["relation"];
        values: Contribution[];
      }
    >();
    for (const group of entries) {
      if (group.event.kind === "message" || !available(group, "tokens"))
        continue;
      const usage = group.event.usage;
      if (usage === null) continue;
      const reported = new Map<
        string,
        {
          name: string;
          relation: TokenComponent["relation"];
          value: number | null;
        }
      >();
      for (const component of usage.components) {
        const key = JSON.stringify([component.name, component.relation]);
        const previous = reported.get(key);
        reported.set(key, {
          ...component,
          value:
            previous !== undefined && previous.value !== component.value
              ? null
              : component.value,
        });
      }
      for (const [key, component] of reported) {
        const category = categories.get(key) ?? {
          name: component.name,
          relation: component.relation,
          values: [],
        };
        categories.set(key, category);
        if (component.value === null) continue;
        const parent =
          component.relation === "subset-of-input"
            ? usage?.input
            : component.relation === "subset-of-output"
              ? usage?.output
              : null;
        if (parent !== null && parent !== undefined && component.value > parent)
          continue;
        category.values.push({ value: component.value, group });
      }
    }
    return Object.freeze(
      [...categories.values()].map((category) =>
        Object.freeze({
          name: category.name,
          relation: category.relation,
          tokens: tokenTotal(
            `token-component:${JSON.stringify([category.name, category.relation])}`,
            entries,
            category.values,
            metricScope === scope ? models.length : entries.length,
            "Reported component only; its declared overlap is preserved and it is not added to input/output.",
            metricScope,
          ),
        }),
      ),
    );
  };

  /** Extract only explicitly present input/output measurements, preserving reported zero. */
  const counters = (
    entries: readonly RecordGroup[],
    field: "input" | "output",
  ): Contribution[] =>
    entries.flatMap((group) => {
      const value =
        group.event.kind === "message" ? null : group.event.usage?.[field];
      return value !== null && value !== undefined && available(group, "tokens")
        ? [{ value, group }]
        : [];
    });

  const observations = groups.filter(
    (group) =>
      group.event.kind !== "message" &&
      group.event.usage !== null &&
      !(
        group.event.kind === "model-call" &&
        group.event.usage.basis === "per-call"
      ),
  );
  return Object.freeze({
    readId: view.id,
    readBounds: Object.freeze({
      startedAtMs: view.startedAtMs,
      finishedAtMs: view.finishedAtMs,
    }),
    scope,
    timing,
    tools: toolResults,
    tokens: Object.freeze({
      input: tokenTotal(
        "input-tokens",
        additive,
        counters(additive, "input"),
        models.length,
        "Sum of distinct model-call per-call input usage; excludes parent and non-additive reports.",
      ),
      output: tokenTotal(
        "output-tokens",
        additive,
        counters(additive, "output"),
        models.length,
        "Sum of distinct model-call per-call output usage; components are not added again.",
      ),
      components: components(additive, scope),
      observations: Object.freeze(
        observations.map((group): UsageObservation => {
          const event = group.event;
          if (event.kind === "message" || event.usage === null)
            throw new Error(
              "Usage observation requires a reported usage object",
            );
          const observationScope: MetricScope = Object.freeze({
            sessionId: session.id,
            kind: "events",
            eventIds: Object.freeze([...group.eventIds]),
          });
          return Object.freeze({
            eventIds: observationScope.eventIds,
            basis: event.usage.basis,
            accountingScope: event.observation?.scope ?? "reported-only",
            model:
              event.observation?.model ??
              event.model?.responded ??
              event.model?.requested ??
              null,
            input: tokenTotal(
              "reported-input-tokens",
              [group],
              counters([group], "input"),
              1,
              "One reported observation, never additive to other reports or per-call usage.",
              observationScope,
            ),
            output: tokenTotal(
              "reported-output-tokens",
              [group],
              counters([group], "output"),
              1,
              "One reported observation, never additive to other reports or per-call usage.",
              observationScope,
            ),
            components: components([group], observationScope),
          });
        }),
      ),
    }),
    exclusions: Object.freeze(
      exclusions.map((entry) =>
        Object.freeze({
          ...entry,
          eventIds: Object.freeze([...entry.eventIds]),
          references: Object.freeze([...entry.references]),
        }),
      ),
    ),
  });
}
