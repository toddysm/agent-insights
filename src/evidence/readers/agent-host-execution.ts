/**
 * Normalize qualified retained Agent Host executions and non-additive usage in memory.
 * Assistant turns are not model calls. Catalog authority, original native scopes and
 * missing evidence survive normalization; captured commands/content are never executed.
 */
import { isDeepStrictEqual } from "node:util";
import { parseReadView, type ReadView } from "../contracts.js";
import type { MultiSourceInput, MultiSourceReader } from "../source-access.js";
import { agentHostCatalogDefinition, resolveAgentHostOwnership } from "./agent-host-catalog.js";
import { identifier, object, readNativeHistory, type NativeEvent } from "./agent-host-history.js";
import { eventTime, executionIdentities, pointerSegment, tokenCount, usageObservation, type NativeExecution, type NativeIssue } from "./agent-host-events.js";
import { agentHostOverlayDefinition, readTurnUsage } from "./agent-host-usage.js";

/** A lifecycle has at most one distinct start and completion; ambiguous alternatives poison it. */
interface Lifecycle {
  readonly kind: "tool-call" | "agent-span" | "assistant-turn";
  readonly nativeId: string | null;
  readonly records: NativeEvent[];
  start?: NativeEvent;
  end?: NativeEvent;
  conflict: boolean;
}

/** Only an omitted optional session ID inherits the qualified enclosing SDK scope; explicit invalid/conflicting values survive. */
function nativeSessionScope(event: NativeEvent, sdk: string): unknown {
  return event.data.sessionId === undefined ? sdk : event.data.sessionId;
}

/** Group calls/turns by native agent/session scope, inheriting only omitted session IDs, never graph proximity. */
function lifecycleKey(event: NativeEvent, sdk: string): { key: string; kind: Lifecycle["kind"]; nativeId: string | null; end: boolean } | null {
  const kind = event.type === "tool.execution_start" || event.type === "tool.execution_complete" ? "tool-call"
    : event.type === "assistant.turn_start" || event.type === "assistant.turn_end" ? "assistant-turn"
    : ["subagent.started", "subagent.completed", "subagent.failed"].includes(event.type) ? "agent-span" : null;
  if (!kind) return null;
  const nativeId = identifier(kind === "assistant-turn" ? event.data.turnId : event.data.toolCallId);
  const badAgent = event.value.agentId !== undefined && identifier(event.value.agentId) === null;
  return {
    key: JSON.stringify([kind, nativeSessionScope(event, sdk), event.value.agentId ?? null,
      nativeId === null || badAgent ? ["unpaired", event.id] : nativeId]),
    kind, nativeId,
    end: ["tool.execution_complete", "assistant.turn_end", "subagent.completed", "subagent.failed"].includes(event.type),
  };
}

/**
 * Read retained tools/agents/turns plus qualified observations. Unsupported native format/runtime
 * publishes no events. Qualified SDK history without unique host ownership remains unassigned
 * with unknown harness identity; it is not misrepresented as Agent Host evidence.
 */
async function read(input: MultiSourceInput): Promise<ReadView> {
  const startedAtMs = Date.now();
  const history = input.get("history");
  const catalog = input.get("catalog");
  const overlay = input.get("overlay");
  const parsed = await readNativeHistory(history, input.readId, input.signal);
  const { records, issues, start, producer, version } = parsed;
  const events: NativeExecution[] = [];
  const sessions: ReadView["sessions"][number][] = [];
  let qualified = false;
  let qualifiedOverlay = false;
  /** Fixed diagnostics never include captured arguments, identifiers or producer error payloads. */
  const issue: NativeIssue = (sourceId, code, message, references = []) => {
    issues.push({ sourceId, code, message, ...(references.length ? { references } : {}) });
  };
  /** No source claims complete capture; snapshots and retained history cannot establish a full call ledger. */
  const finish = (): ReadView => {
    const unavailable = { status: "unavailable" as const, reason: "No qualified evidence for this dimension." };
    const partial = { status: "partial" as const, reason: "Retained native evidence only; gaps, non-additive observations and source diagnostics apply. Per-model-call timing and complete input/output usage are unavailable." };
    return parseReadView({
      schemaVersion: 1, id: input.readId, startedAtMs, finishedAtMs: Date.now(),
      sources: [history, catalog, overlay].map((source, index) => ({
        id: source.sourceId,
        format: !source.available ? null : index === 0 ? "copilot-sdk-events-jsonl"
          : index === 1 ? "vscode-agenthost-catalog-sqlite" : "vscode-agenthost-session-sqlite",
        identity: {
          producer: index === 0 ? producer : null,
          version: index === 0 ? version : source.available && source.kind === "sqlite" ? String(source.userVersion) : null,
          executionHost: qualified && (index !== 2 || qualifiedOverlay) ? "agent-host" : "unknown",
        },
        changedDuringRead: null,
        coverage: {
          messages: unavailable,
          timing: index === 0 && qualified && events.some((event) => event.kind !== "usage-observation" && (event.startedAtMs !== null || event.endedAtMs !== null)) ? partial : unavailable,
          tools: index === 0 && qualified && events.some((event) => event.kind === "tool-call") ? partial : unavailable,
          tokens: qualified && events.some((event) => event.kind === "usage-observation" && event.references.some((reference) => reference.sourceId === source.sourceId)) ? partial : unavailable,
        },
      })),
      sessions, events, issues,
    });
  };
  if (!start) return finish();
  const sdk = String(start.data.sessionId);
  if (start.data.detachedFromSpawningParentSessionId !== undefined &&
      identifier(start.data.detachedFromSpawningParentSessionId) === null)
    issue(history.sourceId, "unsupported-schema", "Detached native session parent is malformed; no parent was inferred.", start.references);
  const ownership = catalog.available && catalog.kind === "sqlite"
    ? await resolveAgentHostOwnership(catalog, sdk, input.signal) : null;
  if (ownership?.ok) {
    qualified = true;
    sessions.push({
      id: `${input.readId}:sdk-session`, nativeId: sdk,
      parentNativeId: identifier(start.data.detachedFromSpawningParentSessionId),
      nativeSession: ownership.value.nativeSession,
      nativeIdentities: [{ namespace: "copilot-sdk-session", value: sdk }, ...ownership.value.identities],
      sourceIds: [history.sourceId, catalog.sourceId, overlay.sourceId],
      references: [...start.references, ...ownership.value.references],
    });
  } else issue(catalog.sourceId, ownership ? "ambiguous-session" : "unreadable-source",
    ownership?.reason ?? "Agent Host catalog is unavailable; native SDK executions remain unassigned.", ownership?.references);
  const sessionId = sessions[0]?.id ?? null;
  const lifecycles = new Map<string, Lifecycle>();
  const poisoned = new Set(parsed.conflicts.flatMap((event) => {
    const key = lifecycleKey(event, sdk);
    return key ? [key.key] : [];
  }));
  for (const event of records.values()) {
    input.signal.throwIfAborted();
    if ((event.value.agentId !== undefined && !identifier(event.value.agentId)) ||
        ["sessionId", "turnId", "toolCallId", "parentToolCallId", "apiCallId", "model"].some((key) =>
          event.data[key] !== undefined && !identifier(event.data[key])))
      issue(history.sourceId, "unsupported-schema", "Reported native identity or model metadata is malformed; invalid fields remain unavailable.", event.references);
    if (eventTime(event) === null)
      issue(history.sourceId, "missing-field", "Native event timestamp is absent or invalid; no timing was inferred.", event.references);
    if (event.value.ephemeral !== undefined && event.value.ephemeral !== false)
      issue(history.sourceId, "unsupported-schema", "Transient or malformed persistence metadata is outside the qualified retained-event contract.", event.references);
    const lifecycle = lifecycleKey(event, sdk);
    if (event.conflict) {
      issue(history.sourceId, "ambiguous-session", "Conflicting native event identity was excluded.", event.references);
      continue;
    }
    if (!lifecycle) continue;
    const previous = lifecycles.get(lifecycle.key) ?? {
      kind: lifecycle.kind, nativeId: lifecycle.nativeId, records: [],
      conflict: poisoned.has(lifecycle.key) || (event.value.ephemeral !== undefined && event.value.ephemeral !== false),
    };
    const slot = lifecycle.end ? "end" : "start";
    const other = previous[slot];
    if (event.value.ephemeral !== undefined && event.value.ephemeral !== false) previous.conflict = true;
    if (other && !isDeepStrictEqual({ ...other.value, id: event.id }, event.value)) previous.conflict = true;
    previous.records.push(event);
    previous[slot] ??= event;
    lifecycles.set(lifecycle.key, previous);
  }
  const agentsByCall = new Map<string, Lifecycle[]>();
  const toolsByCall = new Map<string, number>();
  for (const item of lifecycles.values()) {
    if (item.nativeId === null || item.kind === "assistant-turn") continue;
    if (item.kind === "agent-span") {
      const candidates = agentsByCall.get(item.nativeId) ?? [];
      candidates.push(item); agentsByCall.set(item.nativeId, candidates);
    } else toolsByCall.set(item.nativeId, (toolsByCall.get(item.nativeId) ?? 0) + 1);
  }
  for (const lifecycle of lifecycles.values()) {
    input.signal.throwIfAborted();
    const refs = lifecycle.records.flatMap((event) => event.references);
    if (lifecycle.conflict) {
      issue(history.sourceId, "ambiguous-session", "Conflicting lifecycle identity was excluded, not paired arbitrarily.", refs);
      continue;
    }
    const first = lifecycle.start ?? lifecycle.end;
    if (!first) continue;
    const last = lifecycle.end;
    let malformed = lifecycle.nativeId === null;
    /** Preserve absent optional identity, diagnose invalid and contradictory paired fields. */
    const field = (key: string, envelope = false): string | null => {
      const values = lifecycle.records.map((event) => (envelope ? event.value : event.data)[key]).filter((value) => value !== undefined);
      if (values.some((value) => identifier(value) === null) || new Set(values).size > 1) malformed = true;
      return values.length && new Set(values).size === 1 ? identifier(values[0]) : null;
    };
    const agentId = field("agentId", true);
    const parentToolCallId = field("parentToolCallId");
    const turnId = field("turnId");
    const reportedSession = field("sessionId");
    const assigned = !malformed && (reportedSession === null || reportedSession === sdk);
    let startedAtMs = lifecycle.start ? eventTime(lifecycle.start) : null;
    let endedAtMs = last ? eventTime(last) : null;
    if ((lifecycle.start && startedAtMs === null) || (last && endedAtMs === null))
      issue(history.sourceId, "missing-field", "Lifecycle timestamp is absent or invalid; no timing was inferred.", refs);
    if (startedAtMs !== null && endedAtMs !== null && endedAtMs < startedAtMs) {
      issue(history.sourceId, "unsupported-schema", "Lifecycle completion precedes its start; interval timing is unavailable.", refs);
      startedAtMs = null; endedAtMs = null;
    }
    const completeness = !lifecycle.start ? "missing-start" : !last ? "missing-completion" : "complete";
    if (completeness !== "complete")
      issue(history.sourceId, "missing-field", "Lifecycle boundary is missing from retained history.", refs);
    let status: NativeExecution["status"] = "unknown";
    let cancelled: boolean | null = null;
    if (lifecycle.kind === "tool-call" && last) {
      if (typeof last.data.success === "boolean") status = last.data.success ? "ok" : "error";
      else malformed = true;
      if (last.data.success === true && last.data.error !== undefined) {
        malformed = true; status = "unknown";
      }
    }
    if (lifecycle.kind === "agent-span" && last) {
      if (last.data.cancelled !== undefined && typeof last.data.cancelled !== "boolean") malformed = true;
      else {
        cancelled = typeof last.data.cancelled === "boolean" ? last.data.cancelled : null;
        status = last.type === "subagent.failed" ? "error" : cancelled ? "unknown" : "ok";
      }
    }
    const name = field(lifecycle.kind === "tool-call" ? "toolName" : lifecycle.kind === "agent-span" ? "agentName" : "model");
    if (lifecycle.start && lifecycle.kind !== "assistant-turn" && name === null) malformed = true;
    const parentAgentTaskId = lifecycle.kind === "agent-span" ? field("parentId") : null;
    const parentNativeId = identifier(first.value.parentId);
    for (const event of lifecycle.records) {
      if (event.value.parentId !== null && identifier(event.value.parentId) === null) malformed = true;
      else if (typeof event.value.parentId === "string" && !records.has(event.value.parentId))
        issue(history.sourceId, "missing-field", "Native graph predecessor is outside retained evidence; it is not an execution parent.", event.references);
      if (event.value.ephemeral !== undefined && event.value.ephemeral !== false) malformed = true;
    }
    if (malformed || !assigned)
      issue(history.sourceId, "unsupported-schema", "Lifecycle has malformed or conflicting identity, metadata or status; unavailable fields were not repaired.", refs);
    const agents = lifecycle.kind === "tool-call" && lifecycle.nativeId !== null
      ? agentsByCall.get(lifecycle.nativeId) ?? [] : [];
    const agent = agents[0];
    // Absent spawning parent denotes root. Nested task-registry/agent-ID equivalence is not qualified.
    const wrapper = agents.length === 1 && agent?.conflict === false && agent.start !== undefined &&
      agent.start.data.parentId === undefined && nativeSessionScope(agent.start, sdk) === sdk &&
      nativeSessionScope(first, sdk) === sdk &&
      agentId === null && lifecycle.records.every((event) => event.value.agentId === undefined) &&
      toolsByCall.get(lifecycle.nativeId ?? "") === 1;
    if (agents.length > 0 && !wrapper)
      issue(history.sourceId, "ambiguous-session", "Tool and subagent IDs overlap without a qualified unique root-parent relationship; accounting is ambiguous and non-additive.", refs);
    events.push({
      id: `${input.readId}:execution:${events.length}`, kind: lifecycle.kind,
      sessionId: assigned ? sessionId : null, nativeId: lifecycle.nativeId, parentNativeId,
      references: refs, name, startedAtMs, endedAtMs, status, usage: null,
      nativeIdentities: executionIdentities(lifecycle.records, sdk),
      ...(lifecycle.kind === "tool-call" ? { tool: { name, callId: lifecycle.nativeId } } : {}),
      content: {
        inputMessages: null, outputMessages: null,
        toolArguments: lifecycle.start?.data.arguments === undefined ? null : JSON.stringify(lifecycle.start.data.arguments),
        toolResult: object(last?.data.result) && typeof last.data.result.content === "string" ? last.data.result.content : null,
      },
      nativeExecution: {
        eventIds: lifecycle.records.map((event) => event.id),
        parentEventIds: [...new Set(lifecycle.records.flatMap((event) => typeof event.value.parentId === "string" ? [event.value.parentId] : []))],
        agentId, turnId, toolCallId: lifecycle.kind === "assistant-turn" ? null : lifecycle.nativeId,
        parentToolCallId, parentAgentTaskId, completeness,
        accounting: wrapper ? "bridge-wrapper" : agents.length > 0 ? "ambiguous" : lifecycle.kind === "assistant-turn" ? "boundary" : "execution",
        cancelled,
      },
    });
    if (lifecycle.kind === "tool-call" && last &&
        (!object(last.data.result) || typeof last.data.result.content !== "string"))
      issue(history.sourceId, "missing-field", "Retained tool result content is unavailable; no output path or command is followed.", last.references);
  }
  readNativeUsage(records, parsed.conflicts, sdk, sessionId, input.readId, events, issue);
  if (ownership?.ok) {
    const retained = await readTurnUsage(overlay, parsed, ownership.value, sessionId, input.readId, input.signal, issue);
    events.push(...retained);
    qualifiedOverlay = retained.length > 0;
  } else if (overlay.available)
    issue(overlay.sourceId, "ambiguous-session", "Overlay usage cannot be joined without qualified Agent Host ownership.");
  return finish();
}

/**
 * Preserve output-only message observations once per native API/chunk identity and shutdown
 * model snapshots separately. Unknown operations/ephemeral per-call records are never spans.
 */
function readNativeUsage(
  records: ReadonlyMap<string, NativeEvent>, conflicts: readonly NativeEvent[],
  sdk: string, sessionId: string | null, readId: string,
  events: NativeExecution[], issue: NativeIssue,
): void {
  const responses = new Map<string, NativeEvent[]>();
  /** Scope API responses using the enclosing SDK ID only when omitted; conflicting aliases poison every affected group. */
  const responseKey = (event: NativeEvent): string =>
    JSON.stringify([nativeSessionScope(event, sdk), event.value.agentId ?? null, identifier(event.data.apiCallId) ?? ["event", event.id]]);
  const poisoned = new Set(conflicts.filter((event) => event.type === "assistant.message").map(responseKey));
  const known = new Set([
    "session.start", "session.resume", "session.idle", "session.info", "session.warning", "session.error",
    "session.title_changed", "session.model_change", "session.context_changed", "user.message",
    "assistant.turn_start", "assistant.turn_end", "assistant.idle", "assistant.reasoning",
    "assistant.reasoning_delta", "assistant.message_start", "assistant.message_delta",
    "tool.execution_start", "tool.execution_complete", "tool.execution_partial_result", "tool.execution_progress", "tool.shell_output",
    "subagent.started", "subagent.completed", "subagent.failed", "subagent.selected", "subagent.deselected", "subagent.configured",
    "system.message", "system.notification", "skill.invoked", "abort", "pending_messages.modified",
  ]);
  for (const event of records.values()) {
    if (event.type === "assistant.message") {
      if (event.data.outputTokens !== undefined || event.conflict) {
        const key = responseKey(event);
        const group = responses.get(key) ?? [];
        group.push(event); responses.set(key, group);
      }
    } else if (event.type === "session.shutdown" && !event.conflict) {
      if (event.value.agentId !== undefined || (event.value.ephemeral !== undefined && event.value.ephemeral !== false) ||
          (event.data.sessionId !== undefined && event.data.sessionId !== sdk)) {
        issue(event.references[0]!.sourceId, "unsupported-schema", "Shutdown snapshot identity or persistence metadata conflicts with the qualified session.", event.references);
        continue;
      }
      if (!object(event.data.modelMetrics)) {
        issue(event.references[0]!.sourceId, "missing-field", "Shutdown has no qualified model usage snapshot.", event.references);
        continue;
      }
      for (const [model, metric] of Object.entries(event.data.modelMetrics)) {
        const usage = object(metric) && object(metric.usage) ? metric.usage : {};
        const input = tokenCount(usage.inputTokens);
        const output = tokenCount(usage.outputTokens);
        if (!model || input === null || output === null)
          issue(event.references[0]!.sourceId, "unsupported-schema", "Shutdown usage counters are absent or malformed; no zero totals were supplied.", event.references);
        if (!model || (input === null && output === null)) continue;
        const components: NonNullable<NativeExecution["usage"]>["components"][number][] = [];
        for (const field of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
          if (usage[field] === undefined) continue;
          const value = tokenCount(usage[field]);
          if (value === null)
            issue(event.references[0]!.sourceId, "unsupported-schema", "Shutdown token component is malformed and remains unavailable.", event.references);
          else components.push({ name: field, value, relation: "unknown" });
        }
        events.push(usageObservation(`${readId}:snapshot:${events.length}`, sessionId, sdk, [event],
          "session-snapshot", model, { basis: "cumulative", input, output, components },
          event.references.map((reference) => ({ ...reference, location: { ...reference.location, pointer: `/data/modelMetrics/${pointerSegment(model)}/usage` } }))));
      }
    } else if (["session.compaction_start", "session.compaction_complete", "session.truncation", "session.context_cleared", "session.snapshot_rewind"].includes(event.type))
      issue(event.references[0]!.sourceId, "truncated-record", "Captured context activity does not establish physical log completeness or per-call usage.", event.references);
    else if (!known.has(event.type))
      issue(event.references[0]!.sourceId, "unknown-record", "Native operation is outside the qualified retained execution mapping; no model span or usage was inferred.", event.references);
  }
  for (const group of responses.values()) {
    const first = group[0]!;
    const refs = group.flatMap((event) => event.references);
    const counts = new Set(group.map((event) => event.data.outputTokens));
    const chunked = group.some((event) => event.data.chunkIndex !== undefined || event.data.chunkCount !== undefined);
    const count = first.data.chunkCount;
    const validChunks = !chunked ? group.length === 1 :
      typeof count === "number" && Number.isSafeInteger(count) && count > 0 && group.length === count &&
      new Set(group.map((event) => event.data.chunkIndex)).size === count &&
      group.every((event) => event.data.chunkCount === count && typeof event.data.chunkIndex === "number" &&
        Number.isSafeInteger(event.data.chunkIndex) && event.data.chunkIndex >= 0 && event.data.chunkIndex < count);
    const output = tokenCount(first.data.outputTokens);
    if (poisoned.has(responseKey(first)) ||
        group.some((event) => event.conflict ||
          (event.value.ephemeral !== undefined && event.value.ephemeral !== false) ||
          (event.value.agentId !== undefined && !identifier(event.value.agentId)) ||
          identifier(event.data.model) !== identifier(first.data.model)) ||
        !identifier(first.data.apiCallId) || !validChunks || counts.size !== 1 || output === null) {
      issue(first.references[0]!.sourceId, "unsupported-schema", "Assistant output usage has incomplete or conflicting API/chunk identity or counters; it was excluded.", refs);
      continue;
    }
    const assigned = first.data.sessionId === undefined || first.data.sessionId === sdk;
    if (!assigned)
      issue(first.references[0]!.sourceId, "ambiguous-session", "Assistant usage reports another native session and remains unassigned.", refs);
    events.push(usageObservation(`${readId}:output:${events.length}`, assigned ? sessionId : null, sdk, group,
      "assistant-output", identifier(first.data.model), { basis: "unknown", input: null, output, components: [] },
      refs.map((reference) => ({ ...reference, location: { ...reference.location, pointer: "/data/outputTokens" } }))));
  }
}

/** Native history/catalog plus an explicitly bound optional overlay; all paths are caller grants, not captured values. */
export const agentHostExecutionReader: MultiSourceReader = Object.freeze({
  id: "agent-host-executions",
  inputs: Object.freeze([
    { key: "history", kind: "file", format: "copilot-sdk-events-jsonl", optional: true },
    { key: "catalog", kind: "sqlite", format: "vscode-agenthost-catalog-sqlite", optional: true, database: agentHostCatalogDefinition },
    { key: "overlay", kind: "sqlite", format: "vscode-agenthost-session-sqlite", optional: true, database: agentHostOverlayDefinition },
  ] as const),
  read,
});
