/**
 * Shared native field/provenance normalization for executions and usage observations.
 * These helpers do not correlate lifecycles, access sources or calculate additive metrics.
 */
import type { ReadView, EvidenceReference } from "../contracts.js";
import { identifier, nativeTimestamp, type NativeEvent } from "./agent-host-history.js";

/** Published execution/boundary/observation shape, never a reconstructed transcript. */
export type NativeExecution = Exclude<ReadView["events"][number], { kind: "message" }>;
/** Payload-free issues retain original source anchors without captured diagnostic text. */
export type NativeIssue = (sourceId: string, code: ReadView["issues"][number]["code"], message: string, references?: readonly EvidenceReference[]) => void;

/** Validate timestamps without normalizing impossible dates or supplying observation-time substitutes. */
export function eventTime(event: NativeEvent): number | null {
  const parsed = nativeTimestamp.safeParse(event.value.timestamp);
  const value = parsed.success ? Date.parse(parsed.data) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Reject fractional, negative and unsafe counters; absence remains distinct from zero. */
export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Escape property names only as JSON Pointer segments, never as SQL or filesystem paths. */
export function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Preserve every reported native namespace independently of resolved host session membership. */
export function executionIdentities(records: readonly NativeEvent[], sdk: string): NonNullable<NativeExecution["nativeIdentities"]> {
  const result: NonNullable<NativeExecution["nativeIdentities"]>[number][] = [];
  /** Deduplicate identical namespace/value pairs, not equal values from different namespaces. */
  const add = (namespace: typeof result[number]["namespace"], value: string | null): void => {
    if (value !== null && !result.some((entry) => entry.namespace === namespace && entry.value === value))
      result.push({ namespace, value });
  };
  add("copilot-sdk-session", sdk);
  for (const event of records) {
    add("copilot-sdk-session", identifier(event.data.sessionId));
    add("copilot-sdk-event", event.id);
    add("copilot-sdk-agent", identifier(event.value.agentId));
    add("copilot-sdk-tool-call", identifier(event.data.toolCallId));
    add("copilot-sdk-tool-call", identifier(event.data.parentToolCallId));
    add("copilot-sdk-turn", identifier(event.data.turnId));
    add("copilot-sdk-api-call", identifier(event.data.apiCallId));
  }
  return result;
}

/** Construct a non-additive observation with original field anchors and explicit null counters. */
export function usageObservation(
  id: string, sessionId: string | null, sdk: string, records: readonly NativeEvent[],
  scope: NonNullable<NativeExecution["observation"]>["scope"], model: string | null,
  usage: NonNullable<NativeExecution["usage"]>, references: readonly EvidenceReference[],
): NativeExecution {
  const first = records[0];
  return {
    id, kind: "usage-observation", sessionId, nativeId: first?.id ?? null,
    parentNativeId: identifier(first?.value.parentId), references,
    name: model, startedAtMs: first ? eventTime(first) : null, endedAtMs: null,
    status: "unknown", usage, nativeIdentities: executionIdentities(records, sdk),
    observation: { scope, model, additive: false },
  };
}
