/**
 * Discover qualified Agent Host records only inside explicitly selected startup grants.
 * Paths identify candidates, never harness/session identity. Catalog snapshots and
 * native headers establish matches; no replicated catalog or historical fallback exists.
 */
import path from "node:path";
import type { EvidenceReference } from "../evidence/contracts.js";
import {
  agentHostCatalogDefinition,
  prepareAgentHostDiscoveryCatalog,
  resolveAgentHostOwnership,
} from "../evidence/readers/agent-host-catalog.js";
import { agentHostOverlayDefinition } from "../evidence/readers/agent-host-usage.js";
import {
  readNativeHistory,
  object,
  identifier,
} from "../evidence/readers/agent-host-history.js";
import type {
  SourceRequirement,
  SqliteInput,
} from "../evidence/source-access.js";
import {
  discoveryResultSchema,
  MAX_CONTROL_BODY_BYTES,
  type DiscoveryRequest,
  type DiscoveryResult,
  type ReadSetRequest,
} from "./protocol.js";
import { SourceAccess, byteChunks } from "./sources.js";
import {
  SourceReadSet,
  sqliteReference,
  type SourceBinding,
} from "./source-read.js";
import { RuntimeError, cancelledRead } from "./errors.js";
import type { NativeHelperResolver } from "./sqlite.js";

/** A relative location remains bound to its original startup grant throughout discovery. */
type Location = Pick<SourceBinding, "sourceId" | "relativePath">;
/** Header identity is independent of directory naming and physical aliases. */
interface HistoryCandidate {
  readonly location: Location;
  readonly sdk: string;
  readonly references: readonly EvidenceReference[];
}
/** Overlay ownership is used only when explicitly retained, never inferred from its directory key. */
interface OverlayCandidate {
  readonly location: Location;
  readonly owner: string;
  readonly references: readonly EvidenceReference[];
}

/**
 * Own all discovery database processes through real disposal, including failed cleanup.
 * A run returns only transient controls/witnesses; callers own cancellation and publication.
 */
export class SourceDiscovery {
  private readonly sets = new Set<SourceReadSet>();
  private readonly observations: DiscoveryResult["observations"][number][] = [];
  private readonly locators: DiscoveryResult["locators"][number][] = [];
  private readonly issues: DiscoveryResult["issues"][number][] = [];
  private sequence = 0;
  private candidates = 0;
  private readonly implicitRoots = new Map<string, string>();
  private readonly explicitLocations = new Set<string>();

  /** Bind this generation to approved access and a trusted helper resolver, never capture-supplied code. */
  constructor(
    private readonly access: SourceAccess,
    private readonly nativeHelper: NativeHelperResolver,
    private readonly id: string,
    private readonly signal: AbortSignal,
  ) {}

  /** Stable control key, never a filesystem or session identity. */
  private locationKey(location: Location): string {
    return JSON.stringify([location.sourceId, location.relativePath]);
  }

  /** Preserve generated-root restrictions across a later reopen; explicit file aliases remain allowed. */
  private binding(
    key: string,
    location: Location,
  ): ReadSetRequest["sources"][number] {
    const discoveryRoot = this.implicitRoots.get(this.locationKey(location));
    return {
      key,
      ...location,
      ...(discoveryRoot !== undefined ? { discoveryRoot } : {}),
    };
  }

  /** Revalidate every implicit component without broadening the startup grant or following child links. */
  private async verifyLocation(location: Location): Promise<void> {
    const root = this.implicitRoots.get(this.locationKey(location));
    if (root !== undefined)
      await this.access.verifyDiscoveryPath(
        location.sourceId,
        root,
        location.relativePath,
        this.signal,
      );
  }

  /** Preserve controlled expected failures; cleanup, cancellation, limits and unexpected errors must reject. */
  private problem(location: Location, error: unknown): void {
    if (
      !(error instanceof RuntimeError) ||
      ![
        "SOURCE_MISSING", "SOURCE_UNAVAILABLE", "SOURCE_DENIED", "SOURCE_IO",
        "SOURCE_CHANGED", "SOURCE_SCOPE", "SOURCE_LINK", "NOT_A_FILE", "NOT_A_DIRECTORY",
        "SQLITE_SCHEMA", "SQLITE_FORMAT", "SQLITE_SIDECARS", "SQLITE_RECOVERY_REQUIRED",
        "SQLITE_JOURNAL_PRESENT", "SQLITE_LOCKED",
      ].includes(error.code) ||
      this.signal.aborted
    )
      throw error;
    this.issues.push({ ...location, code: error.code, message: error.message });
  }

  /** Reject excess candidates before opening them; directory and per-input limits also apply. */
  private count(): void {
    if (++this.candidates > 64)
      throw new RuntimeError(
        "DISCOVERY_LIMIT",
        "Discovery exceeds 64 candidate files; select narrower roots.",
        413,
      );
  }

  /** Deduplicate SQLite main/sidecar footprints, not main inodes alone; history aliases use file identity. */
  private async physical(location: Location, database: boolean): Promise<string> {
    await this.verifyLocation(location);
    if (database) {
      const lease = await this.access.database(location.sourceId, location.relativePath, this.signal);
      try {
        if (await lease.verify())
          throw new RuntimeError("SOURCE_CHANGED", "A discovery database changed during admission.", 409);
        await this.verifyLocation(location);
        return JSON.stringify([
          lease.main.dev, lease.main.ino,
          Object.entries(lease.sidecars).sort(([left], [right]) => left.localeCompare(right))
            .map(([name, state]) => [name, state ? [state.dev, state.ino] : null]),
        ]);
      } finally {
        await lease.close();
      }
    }
    return this.access.withStream(
      location.sourceId,
      location.relativePath,
      this.signal,
      async (source) => {
        await source.verify();
        await this.verifyLocation(location);
        return JSON.stringify([source.identity.dev, source.identity.ino]);
      },
    );
  }

  /** Open one code-owned SQLite role and retain its process until finish/dispose has actually completed. */
  private async database<T>(
    location: Location,
    database: Extract<SourceRequirement, { kind: "sqlite" }>["database"],
    format: Extract<SourceRequirement, { kind: "sqlite" }>["format"],
    read: (input: SqliteInput) => Promise<T>,
  ): Promise<T> {
    await this.verifyLocation(location);
    const set = new SourceReadSet(
      `${this.id}:database:${++this.sequence}`,
      this.signal,
      this.access,
      {
        inputs: [{ key: "database", kind: "sqlite", format, database }],
      },
      this.nativeHelper,
    );
    this.sets.add(set);
    try {
      await set.prepare([{ ...location, key: "database" }]);
      const input = set.get("database");
      if (!input.available || input.kind !== "sqlite")
        throw new RuntimeError(
          "SOURCE_UNAVAILABLE",
          "The selected discovery database is unavailable.",
          422,
        );
      this.locators.push({ evidenceSourceId: input.sourceId, ...location });
      const result = await read(input);
      const observations = await set.finish();
      await this.verifyLocation(location);
      this.observations.push(...observations);
      if (observations.some((observation) => observation.changed))
        throw new RuntimeError(
          "SOURCE_CHANGED",
          "A discovery database changed; refresh its sources.",
          409,
        );
      return result;
    } finally {
      await set.dispose();
      this.sets.delete(set);
    }
  }

  /**
   * Expand only documented layout levels. Settings means appSettingsHome
   * (normally User), not a guessed OS home. Custom files use exact catalog/history/overlay roles.
   * An absent implicit profiles directory is empty; selected-root failures remain explicit.
   */
  private async locations(
    request: DiscoveryRequest,
  ): Promise<Map<DiscoveryRequest["roots"][number]["layout"], Location[]>> {
    const result = new Map<
      DiscoveryRequest["roots"][number]["layout"],
      Location[]
    >();
    /** Candidate controls retain the grant, never a reconstructed absolute path. */
    const add = (
      kind: "catalog" | "history" | "overlay",
      location: Location,
      implicitRoot?: string,
    ): void => {
      this.count();
      const key = this.locationKey(location);
      if (implicitRoot === undefined) {
        this.explicitLocations.add(key);
        this.implicitRoots.delete(key);
      } else if (!this.explicitLocations.has(key))
        this.implicitRoots.set(key, implicitRoot);
      const list = result.get(kind) ?? [];
      list.push(location);
      result.set(kind, list);
    };
    for (const root of request.roots) {
      if (this.signal.aborted) throw cancelledRead(this.signal);
      const location = {
        sourceId: root.sourceId,
        relativePath: root.relativePath,
      };
      try {
        const kind = await this.access.kind(root.sourceId, root.relativePath, this.signal);
        if (
          root.layout === "catalog" ||
          kind === "file"
        ) {
          if (root.layout === "settings")
            throw new RuntimeError(
              "NOT_A_DIRECTORY",
              "Settings discovery needs an approved app settings directory.",
              400,
            );
          add(root.layout, location);
          continue;
        }
        if (root.layout === "settings") {
          add(
            "catalog",
            {
              ...location,
              relativePath: path.join(
                root.relativePath,
                "globalStorage",
                "agent-host.db",
              ),
            },
            root.relativePath,
          );
          const profiles = path.join(root.relativePath, "profiles");
          try {
            await this.access.verifyDiscoveryPath(
              root.sourceId,
              root.relativePath,
              profiles,
              this.signal,
            );
            for (const entry of await this.access.entries(
              root.sourceId,
              profiles,
              this.signal,
            ))
              if (entry.kind === "directory")
                add(
                  "catalog",
                  {
                    ...location,
                    relativePath: path.join(
                      profiles,
                      entry.name,
                      "globalStorage",
                      "agent-host.db",
                    ),
                  },
                  root.relativePath,
                );
          } catch (error) {
            if (
              !(error instanceof RuntimeError) ||
              error.code !== "SOURCE_MISSING" ||
              this.signal.aborted
            )
              throw error;
            await this.access.verifyDiscoveryPath(
              root.sourceId,
              root.relativePath,
              root.relativePath,
              this.signal,
            );
          }
        } else {
          const filename =
            root.layout === "history" ? "events.jsonl" : "session.db";
          for (const entry of await this.access.entries(
            root.sourceId,
            root.relativePath,
            this.signal,
          )) {
            if (entry.kind === "file" && entry.name === filename)
              add(
                root.layout,
                {
                  ...location,
                  relativePath: path.join(root.relativePath, filename),
                },
                root.relativePath,
              );
            else if (entry.kind === "directory")
              add(
                root.layout,
                {
                  ...location,
                  relativePath: path.join(
                    root.relativePath,
                    entry.name,
                    filename,
                  ),
                },
                root.relativePath,
              );
          }
        }
      } catch (error) {
        this.problem(location, error);
      }
    }
    return result;
  }

  /** Read just the bounded first physical line; a full session read still reopens and qualifies current inputs. */
  private async header(location: Location): Promise<HistoryCandidate | null> {
    await this.verifyLocation(location);
    return this.access.withStream(
      location.sourceId,
      location.relativePath,
      this.signal,
      async (source) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of source.chunks()) {
          const newline = chunk.indexOf(10);
          const prefix = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
          size += prefix.length;
          if (size > 256 * 1024)
            throw new RuntimeError(
              "READ_LIMIT",
              "A native discovery header exceeds 256 KiB.",
              413,
            );
          chunks.push(prefix);
          if (newline >= 0) break;
        }
        const sourceId = `${this.id}:header:${++this.sequence}`;
        this.locators.push({ evidenceSourceId: sourceId, ...location });
        const history = await readNativeHistory(
          {
            available: true,
            kind: "file",
            sourceId,
            bytes: byteChunks(Buffer.concat(chunks), this.signal),
          },
          this.id,
          this.signal,
        );
        const observation = await source.verify();
        await this.verifyLocation(location);
        this.observations.push({
          sourceId,
          kind: "file",
          available: true,
          startedAtMs: source.startedAtMs,
          finishedAtMs: Date.now(),
          changed: observation.changed,
        });
        if (observation.changed)
          throw new RuntimeError(
            "SOURCE_CHANGED",
            "Native history changed during discovery; refresh its sources.",
            409,
          );
        if (!history.start) {
          this.issues.push({
            ...location,
            code: "UNQUALIFIED_HISTORY",
            message:
              "Empty, wrong-runtime or unsupported native history; no Agent Host session was inferred.",
          });
          return null;
        }
        return {
          location,
          sdk: String(history.start.data.sessionId),
          references: history.start.references,
        };
      },
    );
  }

  /** Resolve one manual request; duplicates require physical identity, not text, timestamps or path proximity. */
  async run(
    request: DiscoveryRequest,
    unavailableReason?: string,
  ): Promise<DiscoveryResult> {
    const startedAtMs = Date.now();
    if (unavailableReason !== undefined)
      return discoveryResultSchema.parse({
        id: this.id,
        startedAtMs,
        finishedAtMs: Date.now(),
        sessions: [],
        observations: [],
        locators: [],
        issues: request.roots.map((root) => ({
          sourceId: root.sourceId,
          relativePath: root.relativePath,
          code: "READER_UNAVAILABLE",
          message: unavailableReason,
        })),
      });
    const locations = await this.locations(request);
    const histories: HistoryCandidate[] = [];
    const overlays: OverlayCandidate[] = [];
    const assignedOverlays = new Set<OverlayCandidate>();
    const sessions: DiscoveryResult["sessions"][number][] = [];
    const physical = new Set<string>();
    for (const role of ["history", "overlay", "catalog"] as const) {
      for (const location of locations.get(role) ?? []) {
        if (this.signal.aborted) throw cancelledRead(this.signal);
        try {
          const key = `${role}:${await this.physical(location, role !== "history")}`;
          if (physical.has(key)) continue;
          physical.add(key);
          if (role === "history") {
            const header = await this.header(location);
            if (header) histories.push(header);
          } else if (role === "overlay") {
            const ownership = await this.database(
              location,
              agentHostOverlayDefinition,
              "vscode-agenthost-session-sqlite",
              async (input) => {
                const rows = await input.query("metadata", {
                  key: "agentHost.rowOwnerChat",
                });
                const row = rows[0];
                const owner =
                  rows.length === 1 &&
                  row?.values.key === "agentHost.rowOwnerChat"
                    ? identifier(row.values.value)
                    : null;
                return owner && row
                  ? {
                      owner,
                      references: [sqliteReference(input.sourceId, row)],
                    }
                  : null;
              },
            );
            if (ownership) overlays.push({ location, ...ownership });
            else
              this.issues.push({
                ...location,
                code: "OVERLAY_UNASSIGNED",
                message:
                  "Overlay lacks unique explicit chat ownership; no path-based match was attempted.",
              });
          } else {
            const discovered = await this.database(
              location,
              agentHostCatalogDefinition,
              "vscode-agenthost-catalog-sqlite",
              async (catalog) => {
                const result: DiscoveryResult["sessions"][number][] = [];
                const rows = await catalog.query("discovery_chats", {});
                if (rows.length > 64)
                  throw new RuntimeError(
                    "DISCOVERY_LIMIT",
                    "A catalog exceeds 64 chat rows; select a narrower catalog.",
                    413,
                  );
                const ownershipCatalog = await prepareAgentHostDiscoveryCatalog(
                  catalog,
                  rows,
                  this.signal,
                );
                const backings = new Set<string>();
                for (const row of rows) {
                  let sdk: string | null = null;
                  if (typeof row.values.provider_data === "string") {
                    let backing: unknown;
                    try {
                      backing = JSON.parse(row.values.provider_data) as unknown;
                    } catch (error) {
                      if (!(error instanceof SyntaxError)) throw error;
                    }
                    sdk = object(backing)
                      ? identifier(backing.sdkSessionId)
                      : null;
                  } else if (
                    row.values.provider_data === null &&
                    typeof row.values.storage_resource === "string"
                  )
                    sdk =
                      /^copilotcli:\/([A-Za-z0-9._-]+)$/.exec(
                        row.values.storage_resource,
                      )?.[1] ?? null;
                  if (sdk === null) {
                    this.issues.push({
                      ...location,
                      code: "UNQUALIFIED_BACKING",
                      message:
                        "A catalog row has no qualified native SDK backing; it was not treated as a session.",
                    });
                    continue;
                  }
                  if (backings.has(sdk)) continue;
                  backings.add(sdk);
                  const ownership = await resolveAgentHostOwnership(
                    ownershipCatalog,
                    sdk,
                    this.signal,
                  );
                  const matches = histories.filter(
                    (history) => history.sdk === sdk,
                  );
                  const overlayMatches = ownership.ok
                    ? overlays.filter((overlay) =>
                        ownership.value.identities.some(
                          (identity) =>
                            [
                              "agent-host-chat",
                              "agent-host-storage-chat",
                            ].includes(identity.namespace) &&
                            identity.value === overlay.owner,
                        ),
                      )
                    : [];
                  const ready = ownership.ok && matches.length === 1;
                  for (const match of overlayMatches)
                    assignedOverlays.add(match);
                  const history = matches[0];
                  const overlay =
                    overlayMatches.length === 1
                      ? overlayMatches[0]?.location
                      : null;
                  const selection: DiscoveryResult["sessions"][number]["selection"] =
                    ready && history && ownership.ok
                      ? {
                          readerId: "agent-host-sessions",
                          expectedSession: {
                            nativeIdentities: [
                              { namespace: "copilot-sdk-session", value: sdk },
                              ...ownership.value.identities,
                            ],
                          },
                          sources: [
                            this.binding("history", history.location),
                            this.binding("catalog", location),
                            ...(overlay
                              ? [this.binding("overlay", overlay)]
                              : []),
                          ],
                        }
                      : null;
                  if (selection && Buffer.byteLength(JSON.stringify(selection)) > MAX_CONTROL_BODY_BYTES)
                    throw new RuntimeError(
                      "DISCOVERY_LIMIT",
                      "A discovered session exceeds the 8-KiB reopen control limit; no session list was published.",
                      413,
                    );
                  result.push({
                    id: `${this.id}:session:${this.sequence}:${result.length}`,
                    sdkSessionId: sdk,
                    runtime: ownership.ok ? "copilot-agent-host" : "unknown",
                    mode: null,
                    executionLocation: "unknown",
                    archived: ownership.ok
                      ? ownership.value.nativeSession.archived
                      : null,
                    state: ready
                      ? "ready"
                      : !ownership.ok || matches.length > 1
                        ? "ambiguous"
                        : "unavailable",
                    reason: !ownership.ok
                      ? ownership.reason
                      : matches.length === 0
                        ? "Retained native history is missing or rotated; no archive fallback."
                        : matches.length > 1
                          ? "Several distinct native histories claim this SDK identity; no copy was selected."
                          : overlayMatches.length > 1
                            ? "Native history matched; several overlays claim this chat and were excluded."
                            : !overlay
                              ? "Native history matched; retained host usage overlay is unavailable."
                              : "Catalog ownership and native header matched; the reader will revalidate all sources.",
                    references: [
                      ...(ownership.ok
                        ? ownership.value.references
                        : ownership.references),
                      sqliteReference(catalog.sourceId, row),
                      ...matches.flatMap((match) => match.references),
                      ...overlayMatches.flatMap((match) => match.references),
                    ],
                    selection,
                  });
                }
                return result;
              },
            );
            sessions.push(...discovered);
          }
        } catch (error) {
          this.problem(location, error);
        }
      }
    }
    // Independent catalogs may claim the same native backing; neither wins by location or discovery order.
    const claims = new Map<string, number>();
    for (const session of sessions)
      if (session.runtime === "copilot-agent-host")
        claims.set(
          session.sdkSessionId,
          (claims.get(session.sdkSessionId) ?? 0) + 1,
        );
    const correlated = sessions.map((session) =>
      (claims.get(session.sdkSessionId) ?? 0) > 1
        ? {
            ...session,
            state: "ambiguous" as const,
            selection: null,
            reason:
              "Independent catalogs claim the same native backing; select the intended profile/catalog explicitly.",
          }
        : session,
    );
    for (const history of histories)
      if (!sessions.some((session) => session.sdkSessionId === history.sdk))
        this.issues.push({
          ...history.location,
          code: "UNASSIGNED_HISTORY",
          message:
            "Native SDK history has no matching selected Agent Host catalog backing; runtime identity remains unknown.",
        });
    for (const overlay of overlays)
      if (!assignedOverlays.has(overlay))
        this.issues.push({
          ...overlay.location,
          code: "OVERLAY_UNASSIGNED",
          message:
            "Overlay ownership matches no qualified selected catalog chat; no substitute was selected.",
        });
    if (!locations.get("catalog")?.length)
      this.issues.push({
        sourceId: "",
        relativePath: "",
        code: "CATALOG_REQUIRED",
        message:
          "Select a qualified Agent Host catalog or app settings root; SDK history alone cannot establish runtime identity.",
      });
    if (!correlated.length && !this.issues.length)
      this.issues.push({
        sourceId: "",
        relativePath: "",
        code: "NO_RETAINED_SESSIONS",
        message:
          "No retained qualified catalog sessions were found; this is not a successful empty session.",
      });
    return discoveryResultSchema.parse({
      id: this.id,
      startedAtMs,
      finishedAtMs: Date.now(),
      sessions: correlated,
      issues: this.issues,
      observations: this.observations,
      locators: this.locators,
    });
  }

  /** Dispose every retained database owner; failed owners stay available for the runtime's cleanup retry. */
  async dispose(): Promise<void> {
    for (const set of this.sets) {
      await set.dispose();
      this.sets.delete(set);
    }
  }
}
