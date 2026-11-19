/**
 * Resolve reported extension parent-chat links within one bounded read.
 * Associations never assign direct membership, create sessions or cross source namespaces.
 */
import type { ReadView } from "./contracts.js";

/** Only explicit parent-chat metadata participates; messages have no such relationship. */
type Execution = Exclude<ReadView["events"][number], { kind: "message" }>;
/** Resolution is separate from the reported value and its original field evidence. */
type Resolution = Pick<NonNullable<Execution["parentChat"]>, "status" | "sessionId">;

/** True only for a separately resolved association, not direct or inherited session membership. */
export function associatedWithSession(event: ReadView["events"][number], sessionId: string): boolean {
  return event.kind !== "message" &&
    event.parentChat?.status === "resolved" && event.parentChat.sessionId === sessionId;
}

/** Count distinct normalized records by direct membership versus explicit association; usage is not summed. */
export function sessionContributions(view: ReadView, sessionId: string): { directEvents: number; associatedEvents: number } {
  let directEvents = 0;
  let associatedEvents = 0;
  for (const event of view.events) {
    if (event.sessionId === sessionId) directEvents++;
    if (associatedWithSession(event, sessionId)) associatedEvents++;
  }
  return { directEvents, associatedEvents };
}

/**
 * Resolve exact same-source vscode-chat identities, rejecting ambiguity, self-links
 * and every edge inside a cyclic session component, independently of source order.
 * Original values/references and direct membership remain untouched.
 */
export function resolveParentChats(
  events: ReadView["events"],
  sessions: ReadView["sessions"],
): ReadonlyMap<string, Resolution> {
  const index = new Map<string, Set<string>>();
  for (const session of sessions)
    for (const identity of session.nativeIdentities ?? []) {
      if (identity.namespace !== "vscode-chat") continue;
      for (const sourceId of session.sourceIds) {
        const key = JSON.stringify([sourceId, identity.value]);
        const matches = index.get(key) ?? new Set<string>();
        matches.add(session.id);
        index.set(key, matches);
      }
    }
  const result = new Map<string, Resolution>();
  const graph = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind === "message" || !event.parentChat) continue;
    const parent = event.parentChat;
    const matches = index.get(JSON.stringify([parent.reference.sourceId, parent.value]));
    const target = matches?.size === 1 ? [...matches][0] ?? null : null;
    const self = event.nativeIdentities?.some(
      (identity) => identity.namespace === parent.namespace && identity.value === parent.value,
    ) || (target !== null && event.sessionId === target);
    const status = self ? "self" : !matches?.size ? "unresolved" : matches.size > 1 ? "ambiguous" : "resolved";
    result.set(event.id, { status, sessionId: status === "resolved" ? target : null });
    if (status !== "resolved" || target === null || event.sessionId === null) continue;
    const edges = graph.get(event.sessionId) ?? new Set<string>();
    edges.add(target);
    graph.set(event.sessionId, edges);
    const incoming = reverse.get(target) ?? new Set<string>();
    incoming.add(event.sessionId);
    reverse.set(target, incoming);
  }
  // Iterative strongly connected components avoid recursion limits on bounded large scans.
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of graph.keys()) {
    if (visited.has(start)) continue;
    const stack: { id: string; exit: boolean }[] = [{ id: start, exit: false }];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.exit) {
        order.push(current.id);
        continue;
      }
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      stack.push({ id: current.id, exit: true });
      for (const next of graph.get(current.id) ?? [])
        if (!visited.has(next)) stack.push({ id: next, exit: false });
    }
  }
  const components = new Map<string, number>();
  const sizes: number[] = [];
  for (const start of order.reverse()) {
    if (components.has(start)) continue;
    const component = sizes.length;
    let size = 0;
    const stack = [start];
    while (stack.length) {
      const current = stack.pop()!;
      if (components.has(current)) continue;
      components.set(current, component);
      size++;
      for (const previous of reverse.get(current) ?? []) stack.push(previous);
    }
    sizes.push(size);
  }
  for (const event of events) {
    const resolution = result.get(event.id);
    if (!resolution?.sessionId || !event.sessionId) continue;
    const component = components.get(event.sessionId);
    if (component !== undefined && sizes[component]! > 1 &&
      component === components.get(resolution.sessionId))
      result.set(event.id, { status: "cycle", sessionId: null });
  }
  return result;
}
