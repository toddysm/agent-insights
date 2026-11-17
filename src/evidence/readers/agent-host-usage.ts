/**
 * Read the pinned schema-18 retained host usage overlay through borrowed projections.
 * Exact native user-event bridges, current row ownership and foreign-turn exclusions
 * precede accounting. Replacement reports and whole/direct totals are never added together.
 */
import { sqliteDefinitionSchema, type SourceInput, type SqliteRow } from "../source-access.js";
import { sqliteReference } from "../../runtime/source-read.js";
import type { AgentHostOwnership } from "./agent-host-catalog.js";
import { identifier, object, type NativeHistory } from "./agent-host-history.js";
import { pointerSegment, tokenCount, usageObservation, type NativeExecution, type NativeIssue } from "./agent-host-events.js";

/** Project only qualified usage, exact turn/event bridges and explicit row-ownership metadata. */
export const agentHostOverlayDefinition = sqliteDefinitionSchema.parse({
  userVersions: [18],
  tables: [
    { name: "turns", primaryKey: ["id"], columns: ["id", "event_id"] },
    { name: "turn_usage", primaryKey: ["turn_id"], columns: ["turn_id", "usage"] },
    { name: "session_metadata", primaryKey: ["key"], columns: ["key", "value"] },
  ],
  queries: [
    { id: "turns", table: "turns", columns: ["id", "event_id"], filters: [] },
    { id: "usage", table: "turn_usage", columns: ["turn_id", "usage"], filters: [] },
    { id: "metadata", table: "session_metadata", columns: ["key", "value"], filters: [{ column: "key", parameter: "key" }] },
  ],
});

/** JSON is parsed as inert data; syntax errors are diagnosed by the caller, not hidden as valid empty reports. */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

/**
 * Normalize latest per-turn per-model reports from a connection-scoped overlay.
 * Missing/unsupported identity leaves usage unavailable; access/query/cancellation failures reject.
 * Only root native user.message event IDs establish host turn bridges, not assistant loop-turn IDs.
 * Read usage once under the shared row/byte budget, independently of bridged turn count.
 */
export async function readTurnUsage(
  overlay: SourceInput, history: NativeHistory, ownership: AgentHostOwnership,
  sessionId: string | null, readId: string, signal: AbortSignal, issue: NativeIssue,
): Promise<NativeExecution[]> {
  const result: NativeExecution[] = [];
  if (!overlay.available || overlay.kind !== "sqlite") {
    issue(overlay.sourceId, "unreadable-source", "Retained host usage overlay is unavailable; native executions do not imply zero token consumption.");
    return result;
  }
  if (overlay.userVersion !== 18 || overlay.snapshotScope !== "connection") {
    issue(overlay.sourceId, "unsupported-schema", "Retained host usage requires schema 18 in one connection-scoped snapshot.");
    return result;
  }
  const sdk = identifier(history.start?.data.sessionId);
  if (!sdk) return result;
  const metadata: SqliteRow[] = [];
  for (const key of ["agentHost.rowOwnerChat", "agentHost.foreignTurnIds"]) {
    signal.throwIfAborted();
    const rows = await overlay.query("metadata", { key });
    if (rows.some((row) => row.values.key !== key) || rows.length > 1) {
      issue(overlay.sourceId, "ambiguous-session", "Overlay metadata identity is ambiguous or conflicts with its queried key.", rows.map((row) => sqliteReference(overlay.sourceId, row)));
      return result;
    }
    metadata.push(...rows);
  }
  const owner = metadata.find((row) => row.values.key === "agentHost.rowOwnerChat");
  const acceptedOwners = ownership.identities.filter((identity) =>
    identity.namespace === "agent-host-chat" || identity.namespace === "agent-host-storage-chat").map((identity) => identity.value);
  const foreignRow = metadata.find((row) => row.values.key === "agentHost.foreignTurnIds");
  const foreign = foreignRow ? parseJson(foreignRow.values.value) : [];
  const metadataRefs = metadata.map((row) => sqliteReference(overlay.sourceId, row));
  if ((owner && (typeof owner.values.value !== "string" || !acceptedOwners.includes(owner.values.value))) ||
      !Array.isArray(foreign) || foreign.some((id: unknown) => !identifier(id))) {
    issue(overlay.sourceId, "ambiguous-session", "Overlay owner or foreign-turn metadata is malformed or belongs to another chat.", metadataRefs);
    return result;
  }
  const turns = await overlay.query("turns", {});
  const byEvent = new Map<string, SqliteRow[]>();
  for (const row of turns) {
    signal.throwIfAborted();
    const eventId = identifier(row.values.event_id);
    const id = identifier(row.values.id);
    const references = [sqliteReference(overlay.sourceId, row)];
    if (!eventId || !id) {
      issue(overlay.sourceId, "missing-field", "Overlay turn has no exact retained native event bridge.", references);
      continue;
    }
    if (foreign.includes(id)) continue;
    const event = history.records.get(eventId);
    if (!event || event.conflict || event.type !== "user.message" || event.value.agentId !== undefined ||
        (event.value.ephemeral !== undefined && event.value.ephemeral !== false) ||
        (event.data.sessionId !== undefined && event.data.sessionId !== sdk)) {
      issue(overlay.sourceId, "ambiguous-session", "Overlay turn does not identify a unique retained root user event.", references);
      if (event)
        issue(event.references[0]!.sourceId, "ambiguous-session", "Native event cannot establish this retained host-usage bridge.", event.references);
      continue;
    }
    const group = byEvent.get(eventId) ?? [];
    group.push(row); byEvent.set(eventId, group);
  }
  if (byEvent.size === 0) return result;
  const usageByTurn = new Map<string, SqliteRow[]>();
  for (const row of await overlay.query("usage", {})) {
    signal.throwIfAborted();
    const turnId = identifier(row.values.turn_id);
    if (!turnId) {
      issue(overlay.sourceId, "missing-field", "Retained report has no exact host turn identity.", [sqliteReference(overlay.sourceId, row)]);
      continue;
    }
    const rows = usageByTurn.get(turnId) ?? [];
    rows.push(row); usageByTurn.set(turnId, rows);
  }
  for (const [eventId, group] of byEvent) {
    signal.throwIfAborted();
    if (group.length !== 1) {
      issue(overlay.sourceId, "ambiguous-session", "Several host turns claim the same native user event; usage was excluded.", group.map((row) => sqliteReference(overlay.sourceId, row)));
      continue;
    }
    const turn = group[0]!;
    const event = history.records.get(eventId)!;
    const rows = usageByTurn.get(String(turn.values.id)) ?? [];
    if (rows.length === 0) continue;
    const refs = [...metadataRefs, sqliteReference(overlay.sourceId, turn), ...rows.map((row) => sqliteReference(overlay.sourceId, row))];
    if (rows.length !== 1 || rows[0]?.values.turn_id !== turn.values.id) {
      issue(overlay.sourceId, "ambiguous-session", "Retained report does not match the exact unique host turn.", refs);
      continue;
    }
    const row = rows[0]!;
    const report = parseJson(row.values.usage);
    if (!object(report) || !object(report._meta)) {
      issue(overlay.sourceId, "unsupported-schema", "Retained usage has no qualified whole/direct-turn metadata; top-level context gauges were not counted.", refs);
      continue;
    }
    let observed = false;
    for (const [field, scope] of [
      ["turnTokenTotals", "turn-inclusive"], ["directTurnTokenTotals", "turn-direct"],
    ] as const) {
      const totals: unknown = report._meta[field];
      if (totals === undefined) continue;
      if (!Array.isArray(totals)) {
        issue(overlay.sourceId, "unsupported-schema", "Retained per-model turn totals are malformed.", refs);
        continue;
      }
      const modelCounts = new Map<string, number>();
      for (const item of totals) {
        if (object(item) && identifier(item.model)) {
          const model = String(item.model);
          modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
        }
      }
      for (const [index, item] of totals.entries()) {
        const refsForField = [
          ...metadataRefs, sqliteReference(overlay.sourceId, turn),
          sqliteReference(overlay.sourceId, row, "usage", `/_meta/${pointerSegment(field)}/${index}`),
        ];
        if (!object(item) || !identifier(item.model) || modelCounts.get(String(item.model)) !== 1 ||
            tokenCount(item.inputTokens) === null || tokenCount(item.outputTokens) === null || tokenCount(item.cachedTokens) === null) {
          issue(overlay.sourceId, "unsupported-schema", "Retained per-model turn counters are missing, malformed or conflicting; no zeros were supplied.", refsForField);
          continue;
        }
        const observation = usageObservation(`${readId}:turn-usage:${result.length}`, sessionId, sdk, [event],
          scope, String(item.model), {
            basis: "cumulative", input: tokenCount(item.inputTokens), output: tokenCount(item.outputTokens),
            components: [{ name: "cachedTokens", value: Number(item.cachedTokens), relation: "subset-of-input" }],
          }, [...event.references, ...refsForField]);
        result.push({
          ...observation, nativeId: String(turn.values.id),
          // A retained report has no observation timestamp; the bridged user event is not usage time.
          startedAtMs: null,
          nativeIdentities: [...observation.nativeIdentities ?? [], { namespace: "agent-host-turn", value: String(turn.values.id) }],
        });
        observed = true;
      }
    }
    if (!observed)
      issue(overlay.sourceId, "missing-field", "Retained report has no qualified token totals; latest-call/context gauges remain excluded.", refs);
  }
  return result;
}
