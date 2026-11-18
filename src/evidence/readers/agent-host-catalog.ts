/**
 * Resolve one native SDK backing against the pinned Agent Host catalog.
 * Only normalized, current schema-22 ownership in one connection snapshot is admitted. Compatibility
 * mirrors are never combined with authoritative rows or migrated here.
 */
import type { ReadView, EvidenceReference } from "../contracts.js";
import { isDeepStrictEqual } from "node:util";
import {
  sqliteDefinitionSchema,
  type SqliteInput,
  type SqliteRow,
} from "../source-access.js";
import { sqliteReference } from "../../runtime/source-read.js";

/** Fixed projections are shared-reader declarations, never SQL or schemas supplied by captures. */
export const agentHostCatalogDefinition = sqliteDefinitionSchema.parse({
  userVersions: [22],
  tables: [
    {
      name: "chats_v2",
      primaryKey: ["chat_uri"],
      columns: [
        "chat_uri", "owner_session_uri", "storage_resource", "parent_chat",
        "provider_data", "tombstoned", "archived", "origin_session_uri",
      ],
    },
    {
      name: "sessions_v2",
      primaryKey: ["session_uri"],
      columns: ["session_uri", "provider", "session_generation", "verified", "is_chat_backing"],
    },
    {
      name: "session_chat_catalogs",
      primaryKey: ["session_uri"],
      columns: [
        "session_uri", "authority_version", "session_generation",
        "revision", "projected_revision",
      ],
    },
    { name: "metadata", primaryKey: ["key"], columns: ["key", "value"] },
  ],
  queries: [
    {
      id: "discovery_chats",
      table: "chats_v2",
      columns: [
        "chat_uri", "owner_session_uri", "storage_resource", "parent_chat",
        "provider_data", "tombstoned", "archived", "origin_session_uri",
      ],
      filters: [],
    },
    {
      id: "discovery_metadata",
      table: "metadata",
      columns: ["key", "value"],
      filters: [],
    },
    {
      id: "sdk_chats",
      table: "chats_v2",
      columns: [
        "chat_uri", "owner_session_uri", "storage_resource", "parent_chat",
        "provider_data", "tombstoned", "archived", "origin_session_uri",
      ],
      filters: [{ column: "provider_data", jsonPath: ["sdkSessionId"], parameter: "sdk" }],
    },
    {
      id: "session_backed_chats",
      table: "chats_v2",
      columns: [
        "chat_uri", "owner_session_uri", "storage_resource", "parent_chat",
        "provider_data", "tombstoned", "archived", "origin_session_uri",
      ],
      filters: [{ column: "storage_resource", parameter: "storage" }],
    },
    {
      id: "owner",
      table: "sessions_v2",
      columns: ["session_uri", "provider", "session_generation", "verified", "is_chat_backing"],
      filters: [{ column: "session_uri", parameter: "owner" }],
    },
    {
      id: "authority",
      table: "session_chat_catalogs",
      columns: ["session_uri", "authority_version", "session_generation", "revision", "projected_revision"],
      filters: [{ column: "session_uri", parameter: "owner" }],
    },
    {
      id: "storage_identity",
      table: "metadata",
      columns: ["key", "value"],
      filters: [
        { column: "key", parameter: "prefix", prefix: true },
        { column: "value", jsonPath: ["storage"], parameter: "storage" },
      ],
    },
    {
      id: "metadata_key",
      table: "metadata",
      columns: ["key", "value"],
      filters: [{ column: "key", parameter: "key" }],
    },
  ],
});

/** Qualified ownership plus all original rows used to establish it; no path is opened from these values. */
export interface AgentHostOwnership {
  readonly identities: NonNullable<ReadView["sessions"][number]["nativeIdentities"]>;
  readonly references: readonly EvidenceReference[];
  readonly nativeSession: NonNullable<ReadView["sessions"][number]["nativeSession"]>;
}

/** An explicit unavailable/ambiguous result prevents a native file from masquerading as Agent Host evidence. */
export type OwnershipResult =
  | { readonly ok: true; readonly value: AgentHostOwnership }
  | { readonly ok: false; readonly reason: string; readonly references: readonly EvidenceReference[] };

/** Parse metadata as data only; malformed JSON remains unqualified rather than executing producer recovery code. */
function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

/** Only SQLite INTEGER cells (bigint), never exact-valued REAL cells, can establish integer flags. */
function integer(value: unknown, expected: number): boolean {
  return value === BigInt(expected);
}

/**
 * Index only the first top-level string member, as SQLite json_extract does.
 * JSON.parse validates the whole object first; tokenization preserves duplicate
 * keys and escaped labels without reparsing nested values. SQLite's 1000-level
 * JSON limit is retained; deeper objects do not satisfy the guarded predicate.
 */
function jsonStringMember(encoded: unknown, member: string): string | null {
  if (typeof encoded !== "string" || !jsonObject(encoded)) return null;
  let depth = 0;
  let previous: string | undefined;
  let found = false;
  let pending = false;
  let value: string | null = null;
  for (const match of encoded.matchAll(/"(?:\\.|[^"\\])*"|[{}:,]|\[|\]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const token = match[0];
    if (pending) {
      const parsed: unknown = token.startsWith('"') ? JSON.parse(token) : null;
      value = typeof parsed === "string" ? parsed : null;
      pending = false;
    }
    if (token === "{" || token === "[") {
      if (++depth > 1000) return null;
    } else if (token === "}" || token === "]") depth--;
    else if (depth === 1 && token === ":" && previous !== undefined && !found &&
        JSON.parse(previous) === member) {
      found = true;
      pending = true;
    }
    previous = token.startsWith('"') ? token : undefined;
  }
  return value;
}

/**
 * Reuse bounded discovery projections only within this connection snapshot.
 * Exact metadata keys already require binary equality in the resolver. JSON
 * lookup indexes preserve first-member semantics, not JSON.parse's last keys.
 * JSON admission and unsupported string bindings retain native semantics.
 * Original rows/fingerprints survive unchanged; native owner/storage lookups
 * retain their SQLite affinity/collation behavior and all shared budgets.
 */
export async function prepareAgentHostDiscoveryCatalog(
  catalog: SqliteInput,
  chats: readonly SqliteRow[],
  signal: AbortSignal,
): Promise<SqliteInput> {
  if (catalog.userVersion !== 22 || catalog.snapshotScope !== "connection") return catalog;
  signal.throwIfAborted();
  const metadata = await catalog.query("discovery_metadata", {});
  const sdkRows = new Map<string, SqliteRow[]>();
  const metadataRows = new Map<string, SqliteRow[]>();
  const storageRows = new Map<string, SqliteRow[]>();
  /** Group original witnesses without reconstructing rows or their SQLite identities. */
  const append = (index: Map<string, SqliteRow[]>, key: string, row: SqliteRow): void => {
    const rows = index.get(key) ?? [];
    rows.push(row);
    index.set(key, rows);
  };
  for (const row of chats) {
    signal.throwIfAborted();
    const sdk = jsonStringMember(row.values.provider_data, "sdkSessionId");
    if (sdk !== null) append(sdkRows, sdk, row);
  }
  for (const row of metadata) {
    signal.throwIfAborted();
    const key = row.values.key;
    if (typeof key !== "string") continue;
    append(metadataRows, key, row);
    for (const prefix of ["sessionStorageIdentity:", "chatStorageIdentity:"]) {
      if (!key.startsWith(prefix)) continue;
      const storage = jsonStringMember(row.values.value, "storage");
      if (storage !== null)
        append(storageRows, JSON.stringify([prefix, storage]), row);
    }
  }
  return {
    ...catalog,
    async query(queryId, bindings) {
      signal.throwIfAborted();
      if (Object.values(bindings).some((value) => typeof value === "string" && /[\uD800-\uDFFF]/u.test(value)))
        return catalog.query(queryId, bindings);
      const keys = Object.keys(bindings);
      // Other SDK bindings can equal JSON-encoded containers and have no canonical storage-URI lookup.
      if (queryId === "sdk_chats" && keys.length === 1 && typeof bindings.sdk === "string" &&
          /^[A-Za-z0-9._-]+$/.test(bindings.sdk))
        return sdkRows.get(bindings.sdk) ?? [];
      if (queryId === "metadata_key" && keys.length === 1 && typeof bindings.key === "string")
        return metadataRows.get(bindings.key) ?? [];
      if (queryId === "storage_identity" && keys.length === 2 &&
          typeof bindings.prefix === "string" && typeof bindings.storage === "string" &&
          ["sessionStorageIdentity:", "chatStorageIdentity:"].includes(bindings.prefix) &&
          !/^[{[]/.test(bindings.storage.trimStart()))
        return storageRows.get(JSON.stringify([bindings.prefix, bindings.storage])) ?? [];
      return catalog.query(queryId, bindings);
    },
  };
}

/**
 * Verify an exact SDK backing against current normalized ownership and recorded identity translations.
 * A connection-scoped catalog snapshot is required before any ownership query.
 * Unsupported legacy authority, deleted/hidden owners, stale projections, conflicting mappings and
 * multiple current owners fail closed. Bounded query/schema/access failures reject to the runtime.
 */
export async function resolveAgentHostOwnership(
  catalog: SqliteInput,
  sdkSessionId: string,
  signal: AbortSignal,
): Promise<OwnershipResult> {
  const refs: EvidenceReference[] = [];
  /** Retain the exact captured projection for every ownership decision, including rejected rows. */
  const observe = (rows: readonly SqliteRow[]): void => {
    for (const row of rows) refs.push(sqliteReference(catalog.sourceId, row));
  };
  /** Return a controlled reason; no captured identifiers or metadata enter diagnostic text. */
  const fail = (reason: string): OwnershipResult => ({ ok: false, reason, references: refs });
  if (catalog.userVersion !== 22) return fail("Unsupported Agent Host catalog schema.");
  signal.throwIfAborted();
  if (catalog.snapshotScope !== "connection")
    return fail("Agent Host ownership requires a connection-scoped catalog snapshot; per-request snapshots cannot establish consistent ownership.");
  const explicit = await catalog.query("sdk_chats", { sdk: sdkSessionId });
  // The pinned producer mints this canonical session-storage URI for unreserved raw SDK IDs.
  const sessionStorage = /^[A-Za-z0-9._-]+$/.test(sdkSessionId) ? `copilotcli:/${sdkSessionId}` : null;
  const stored = sessionStorage === null ? [] : await catalog.query("session_backed_chats", { storage: sessionStorage });
  observe(explicit);
  observe(stored);
  const matches = new Map<string, SqliteRow>();
  for (const row of [...explicit, ...stored]) {
    const key = JSON.stringify(row.key);
    const previous = matches.get(key);
    if (previous && !isDeepStrictEqual(previous.values, row.values))
      return fail("Agent Host ownership changed between bounded catalog projections.");
    matches.set(key, row);
  }
  const candidates = [...matches.values()];
  if (candidates.some((row) => !integer(row.values.tombstoned, 0) && !integer(row.values.tombstoned, 1)))
    return fail("Agent Host chat has an unsupported deletion flag; ownership cannot be established.");
  const current = candidates.filter((row) => integer(row.values.tombstoned, 0));
  const selected = current[0];
  if (current.length !== 1 || !selected)
    return fail("Native backing has no unique live Agent Host chat; deleted, missing or ambiguous ownership.");
  const chat = selected.values;
  const ownerId = chat.owner_session_uri;
  const chatId = chat.chat_uri;
  if (typeof ownerId !== "string" || !ownerId || typeof chatId !== "string" || !chatId)
    return fail("Agent Host chat has malformed native ownership.");
  const backing = jsonObject(chat.provider_data);
  if (chat.provider_data === null
    ? sessionStorage === null || chat.storage_resource !== sessionStorage || chat.chat_uri === chat.storage_resource
    : backing?.sdkSessionId !== sdkSessionId)
    return fail("Agent Host provider backing does not match the native session.");
  const owners = await catalog.query("owner", { owner: ownerId });
  const authorities = await catalog.query("authority", { owner: ownerId });
  observe(owners);
  observe(authorities);
  const owner = owners[0]?.values;
  const authority = authorities[0]?.values;
  if (owners.length !== 1 || authorities.length !== 1 || !owner || !authority ||
      owner.session_uri !== ownerId || authority.session_uri !== ownerId ||
      owner.provider !== "copilotcli" || !integer(owner.verified, 1) ||
      !integer(owner.is_chat_backing, 0) || !integer(authority.authority_version, 2) ||
      typeof owner.session_generation !== "string" || !owner.session_generation ||
      authority.session_generation !== owner.session_generation ||
      typeof authority.revision !== "bigint" || authority.revision < 0n ||
      authority.revision !== authority.projected_revision)
    return fail("Agent Host owner, generation or normalized catalog authority is unsupported or stale.");
  signal.throwIfAborted();
  // Guarded JSON filters exclude scalar/malformed values; only this owner/chat's mappings consume row budgets.
  const metadata: SqliteRow[] = [];
  for (const { storage, prefix } of [
    { storage: ownerId, prefix: "sessionStorageIdentity:" },
    { storage: chatId, prefix: "chatStorageIdentity:" },
  ])
    metadata.push(...await catalog.query("storage_identity", { storage, prefix }));
  const translations: { runtime: string; storage: string; row: SqliteRow; session: boolean; provider: string | null }[] = [];
  for (const row of metadata) {
    signal.throwIfAborted();
    const key = row.values.key;
    if (typeof key !== "string") return fail("Malformed Agent Host metadata key.");
    const session = key.startsWith("sessionStorageIdentity:");
    if (!session && !key.startsWith("chatStorageIdentity:")) continue;
    const value = jsonObject(row.values.value);
    if (!value || typeof value.runtime !== "string" || !value.runtime ||
        typeof value.storage !== "string" || !value.storage ||
        value.storage !== (session ? ownerId : chatId) ||
        key !== `${session ? "session" : "chat"}StorageIdentity:${value.runtime}` ||
        (session && typeof value.provider !== "string"))
      {
        observe([row]);
        return fail("Agent Host storage identity metadata is unsupported or malformed.");
      }
    translations.push({ runtime: value.runtime, storage: value.storage, row, session, provider: typeof value.provider === "string" ? value.provider : null });
  }
  /** SQLite schema collations cannot substitute differently spelled mapping, status or provider keys. */
  const exactMetadata = async (key: string): Promise<readonly SqliteRow[]> =>
    (await catalog.query("metadata_key", { key })).filter((row) => row.values.key === key);
  /** Retain mapping witnesses; use a stored identity only when both reverse and exact forward keys are absent. */
  const translate = async (stored: string, session: boolean): Promise<string | null> => {
    const found = translations.filter((entry) => entry.session === session && entry.storage === stored);
    observe(found.map((entry) => entry.row));
    if (found.length > 1) return null;
    const entry = found[0];
    if (entry) {
      if (session && entry.provider !== "copilotcli") return null;
      return entry.runtime;
    }
    const forward = await exactMetadata(`${session ? "session" : "chat"}StorageIdentity:${stored}`);
    observe(forward);
    return forward.length === 0 ? stored : null;
  };
  const runtimeOwner = await translate(ownerId, true);
  const runtimeChat = await translate(chatId, false);
  if (!runtimeOwner || !runtimeChat)
    return fail("Agent Host storage identity is ambiguous, malformed or conflicting.");
  const status: SqliteRow[] = [];
  for (const identity of new Set([ownerId, runtimeOwner]))
    for (const prefix of ["sessionTombstone:", "sessionHidden:", "sessionsV2Excluded:copilotcli:", "sessionProvisional:"])
      status.push(...await exactMetadata(`${prefix}${identity}`));
  observe(status);
  if (status.some((row) =>
    [ownerId, runtimeOwner].some((identity) =>
      row.values.key === `sessionTombstone:${identity}` || row.values.key === `sessionProvisional:${identity}`)
    && row.values.value !== "true" && row.values.value !== "false"))
    return fail("Agent Host owner deletion or provisional state is malformed.");
  const suppressed = status.filter((row) =>
    [ownerId, runtimeOwner].some((identity) =>
      (row.values.key === `sessionTombstone:${identity}` && row.values.value === "true") ||
      row.values.key === `sessionHidden:${identity}` ||
      row.values.key === `sessionsV2Excluded:copilotcli:${identity}` ||
      (row.values.key === `sessionProvisional:${identity}` && row.values.value === "true")));
  if (suppressed.length) return fail("Agent Host owner is deleted, hidden or provisional.");
  const providerOverrides: SqliteRow[] = [];
  for (const identity of new Set([chatId, runtimeChat]))
    providerOverrides.push(...await exactMetadata(`chatAgentProvider:${identity}`));
  observe(providerOverrides);
  if (providerOverrides.some((row) => row.values.value !== "copilotcli"))
    return fail("Agent Host chat reports a different provider.");
  if ((chat.storage_resource !== null && (typeof chat.storage_resource !== "string" || !chat.storage_resource)) ||
      (chat.parent_chat !== null && (typeof chat.parent_chat !== "string" || !chat.parent_chat)) ||
      (chat.origin_session_uri !== null && (typeof chat.origin_session_uri !== "string" || !chat.origin_session_uri)) ||
      (!integer(chat.archived, 0) && !integer(chat.archived, 1)))
    return fail("Agent Host chat storage or parent metadata is malformed.");
  return {
    ok: true,
    value: {
      identities: [
        { namespace: "agent-host-session", value: runtimeOwner },
        { namespace: "agent-host-chat", value: runtimeChat },
        { namespace: "agent-host-storage-session", value: ownerId },
        { namespace: "agent-host-storage-chat", value: chatId },
      ],
      references: refs,
      nativeSession: {
        parentChatId: typeof chat.parent_chat === "string" ? chat.parent_chat : null,
        originSessionId: typeof chat.origin_session_uri === "string" ? chat.origin_session_uri : null,
        archived: integer(chat.archived, 1),
        historyScope: "retained-native-log",
      },
    },
  };
}
