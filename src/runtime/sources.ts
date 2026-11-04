/** Read-only access to startup-authorized locations; no scanning, writes or retained byte cache. */
import { constants } from "node:fs";
import { access, open, realpath, stat, lstat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { RuntimeError, cancelledRead, filesystemError } from "./errors.js";
import type { SourceLocation } from "./protocol.js";

export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** A grant is bound to the initial canonical location and kind, not a mutable symlink target. */
interface SourceGrant {
  readonly id: string;
  readonly requested: string;
  readonly canonical: string;
  readonly kind: "file" | "directory" | "unknown";
}

/** Borrowed, bounded in-memory bytes; callers must drop them when the read finishes. */
export interface CapturedSource {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

/**
 * Borrow a bounded capture in at most 64 KiB views, rejecting cancellation before each yield.
 * Readers must not mutate/persist these views; they are not live filesystem handles.
 */
export async function* byteChunks(
  bytes: Uint8Array,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    if (signal.aborted) throw cancelledRead(signal);
    yield bytes.subarray(offset, offset + CHUNK_BYTES);
  }
}

/** Serializable identity/content observations for a database or one of its exact sidecars. */
export interface FileState {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtime: string;
  readonly ctime: string;
}

/** Internal runtime lease, never exposed to readers or browser controls. */
export interface DatabaseLease {
  readonly path: string;
  readonly main: FileState;
  readonly sidecars: Readonly<Record<string, FileState | null>>;
  readonly startedAtMs: number;
  /** Revalidate grant/identity and return whether main/WAL content metadata changed. */
  verify(): Promise<boolean>;
  /** Release the pinned read-only descriptor after the database process has exited. */
  close(): Promise<void>;
}

/** Preserve nanosecond identity observations across the database-process boundary. */
export function fileState(info: BigIntStats): FileState {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtime: String(info.mtimeNs),
    ctime: String(info.ctimeNs),
  };
}

/**
 * Inspect only an exact SQLite sidecar; absence is distinct from access failure.
 * @param file - Runtime-selected main path plus a fixed SQLite suffix.
 * @returns Metadata or null when absent; rejects links/non-files and permission errors.
 */
export async function inspectSidecar(file: string): Promise<FileState | null> {
  try {
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink())
      throw new RuntimeError(
        "SOURCE_LINK",
        "A database sidecar is not a regular file.",
        403,
      );
    if (info.size > BigInt(MAX_SOURCE_BYTES))
      throw new RuntimeError(
        "SOURCE_TOO_LARGE",
        "A database sidecar exceeds the source limit.",
        413,
      );
    return fileState(info);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    filesystemError(error);
  }
}

/** Check containment using platform-native path rules, including cross-drive rejection. */
function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Compare file identity/content metadata without claiming an atomic filesystem snapshot. */
function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Revalidate a locator against an open file identity; expected disappearance/permission changes mean false. */
export async function pointsToOpenedFile(
  candidate: string,
  canonical: string,
  opened: BigIntStats,
): Promise<boolean> {
  try {
    const resolved = await realpath(candidate);
    if (resolved !== canonical) return false;
    const current = await stat(resolved, { bigint: true });
    return current.dev === opened.dev && current.ino === opened.ino;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
        String(error.code),
      )
    ) {
      return false;
    }
    throw error;
  }
}

/** Owns source grants only. No raw bytes or normalized evidence are persisted by this class. */
export class SourceAccess {
  private constructor(private readonly grants: readonly SourceGrant[]) {}

  /** Resolve explicitly supplied roots once. Missing startup locations remain unavailable until restart. */
  static async create(locations: readonly string[]): Promise<SourceAccess> {
    if (
      locations.length > 32 ||
      locations.some(
        (location) => location.length === 0 || location.includes("\0"),
      )
    ) {
      throw new RuntimeError(
        "INVALID_SOURCES",
        "Supply at most 32 non-empty source paths.",
        400,
      );
    }
    const grants = await Promise.all(
      locations.map(async (location, index): Promise<SourceGrant> => {
        const requested = path.resolve(location);
        try {
          const canonical = await realpath(requested);
          const info = await stat(canonical);
          const kind = info.isFile()
            ? "file"
            : info.isDirectory()
              ? "directory"
              : "unknown";
          return { id: `source-${index + 1}`, requested, canonical, kind };
        } catch (error) {
          try {
            filesystemError(error);
          } catch (failure) {
            if (!(failure instanceof RuntimeError)) throw failure;
            return {
              id: `source-${index + 1}`,
              requested,
              canonical: requested,
              kind: "unknown",
            };
          }
        }
      }),
    );
    return new SourceAccess(Object.freeze(grants));
  }

  /** Recheck a grant without silently authorizing a replacement symlink or a changed root kind. */
  private async inspect(grant: SourceGrant): Promise<void> {
    if (grant.kind === "unknown") {
      throw new RuntimeError(
        "SOURCE_UNAVAILABLE",
        "Unavailable at startup. Correct the location and restart to authorize it.",
        404,
      );
    }
    try {
      if ((await realpath(grant.requested)) !== grant.canonical) {
        throw new RuntimeError(
          "ROOT_CHANGED",
          "The configured root changed its target. Restart to authorize the new location.",
          409,
        );
      }
      const info = await stat(grant.canonical);
      if (
        (grant.kind === "file" && !info.isFile()) ||
        (grant.kind === "directory" && !info.isDirectory())
      ) {
        throw new RuntimeError(
          "ROOT_CHANGED",
          "The configured root changed its type. Restart to authorize it.",
          409,
        );
      }
      await access(
        grant.canonical,
        constants.R_OK | (grant.kind === "directory" ? constants.X_OK : 0),
      );
    } catch (error) {
      filesystemError(error);
    }
  }

  /** Return explicit per-location availability, never a successful empty catalog on failure. */
  async list(): Promise<SourceLocation[]> {
    return Promise.all(
      this.grants.map(async (grant) => {
        try {
          await this.inspect(grant);
          return {
            id: grant.id,
            path: grant.requested,
            kind: grant.kind,
            available: true,
            reason: null,
          };
        } catch (error) {
          if (!(error instanceof RuntimeError)) throw error;
          return {
            id: grant.id,
            path: grant.requested,
            kind: grant.kind,
            available: false,
            reason: error.message,
          };
        }
      }),
    );
  }

  /** Resolve one authorized regular source; shared by byte capture and database leases. */
  private async resolve(
    sourceId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<{
    grant: SourceGrant;
    canonical: string;
    candidate: string;
  }> {
    const grant = this.grants.find((candidate) => candidate.id === sourceId);
    if (
      grant === undefined ||
      path.isAbsolute(relativePath) ||
      relativePath.includes("\0")
    ) {
      throw new RuntimeError(
        "SOURCE_SCOPE",
        "The requested path is outside an approved source location.",
        403,
      );
    }
    await this.inspect(grant);
    if (grant.kind === "file" && relativePath !== "") {
      throw new RuntimeError(
        "SOURCE_SCOPE",
        "A file grant cannot read neighboring paths.",
        403,
      );
    }
    const candidate =
      grant.kind === "file"
        ? grant.canonical
        : path.resolve(grant.canonical, relativePath);
    if (!contains(grant.canonical, candidate)) {
      throw new RuntimeError(
        "SOURCE_SCOPE",
        "The requested path is outside an approved source location.",
        403,
      );
    }
    if (signal.aborted) throw cancelledRead(signal);
    try {
      const canonical = await realpath(candidate);
      if (!contains(grant.canonical, canonical)) {
        throw new RuntimeError(
          "SOURCE_SCOPE",
          "Links outside the approved source location cannot be read.",
          403,
        );
      }
      if (!(await stat(canonical)).isFile()) {
        throw new RuntimeError(
          "NOT_A_FILE",
          "Select a regular capture file.",
          400,
        );
      }
      if (signal.aborted) throw cancelledRead(signal);
      return { grant, canonical, candidate };
    } catch (error) {
      filesystemError(error);
    }
  }

  /**
   * Capture an authorized regular file prefix through a read-only descriptor.
   * Reject escapes and sizes over the remaining byte budget (default 64 MiB) before allocation.
   */
  async read(
    sourceId: string,
    relativePath: string,
    signal: AbortSignal,
    budget = MAX_SOURCE_BYTES,
  ): Promise<CapturedSource> {
    if (
      !Number.isSafeInteger(budget) ||
      budget < 0 ||
      budget > MAX_SOURCE_BYTES
    )
      throw new RuntimeError(
        "INVALID_READ_BUDGET",
        "The file capture budget is invalid.",
        500,
      );
    const startedAtMs = Date.now();
    const { grant, canonical, candidate } = await this.resolve(
      sourceId,
      relativePath,
      signal,
    );
    try {
      const flags =
        constants.O_RDONLY |
        (process.platform === "win32"
          ? 0
          : constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const handle = await open(canonical, flags);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile())
          throw new RuntimeError(
            "NOT_A_FILE",
            "Select a regular capture file.",
            400,
          );
        if (before.size > BigInt(MAX_SOURCE_BYTES)) {
          throw new RuntimeError(
            "SOURCE_TOO_LARGE",
            "The source exceeds the 64 MiB read limit. No partial read was substituted.",
            413,
          );
        }
        if (before.size > BigInt(budget))
          throw new RuntimeError(
            "READ_LIMIT",
            "The combined read exceeded its capture-byte limit.",
            413,
          );
        if (!(await pointsToOpenedFile(candidate, canonical, before))) {
          throw new RuntimeError(
            "SOURCE_CHANGED",
            "The source changed while it was being opened. Refresh and retry.",
            409,
          );
        }
        const buffer = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < buffer.length) {
          if (signal.aborted) throw cancelledRead(signal);
          const result = await handle.read(
            buffer,
            offset,
            Math.min(CHUNK_BYTES, buffer.length - offset),
            offset,
          );
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        if (signal.aborted) throw cancelledRead(signal);
        await this.inspect(grant);
        const after = await handle.stat({ bigint: true });
        return {
          bytes: buffer.subarray(0, offset),
          changed:
            offset !== buffer.length ||
            !sameFileState(before, after) ||
            !(await pointsToOpenedFile(candidate, canonical, after)),
          startedAtMs,
          finishedAtMs: Date.now(),
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      filesystemError(error);
    }
  }

  /**
   * Pin a database and validate its exact sidecars without invoking SQLite.
   * @param sourceId - Explicit startup grant identity.
   * @param relativePath - Empty for a file grant, or a confined relative path.
   * @param signal - Read-generation cancellation.
   * @returns Runtime-only lease; caller must close it after database process cleanup.
   * @throws Controlled source errors, including WAL databases missing pre-existing sidecars.
   */
  async database(
    sourceId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<DatabaseLease> {
    const startedAtMs = Date.now();
    const { grant, canonical, candidate } = await this.resolve(
      sourceId,
      relativePath,
      signal,
    );
    const handle = await open(
      canonical,
      constants.O_RDONLY |
        (process.platform === "win32"
          ? 0
          : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    ).catch(filesystemError);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_SOURCE_BYTES))
        throw new RuntimeError(
          "SOURCE_TOO_LARGE",
          "Database exceeds the bounded regular-source limit.",
          413,
        );
      const header = Buffer.alloc(100);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (
        bytesRead !== 100 ||
        header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
      )
        throw new RuntimeError(
          "SQLITE_FORMAT",
          "The selected source is not a supported SQLite database.",
          422,
        );
      const sidecars: Record<string, FileState | null> = {};
      for (const suffix of ["-wal", "-shm", "-journal"])
        sidecars[suffix] = await inspectSidecar(canonical + suffix);
      if (
        before.size +
          Object.values(sidecars).reduce(
            (size, value) => size + BigInt(value?.size ?? 0),
            0n,
          ) >
        BigInt(MAX_SOURCE_BYTES)
      )
        throw new RuntimeError(
          "SOURCE_TOO_LARGE",
          "Database and sidecars exceed the source limit.",
          413,
        );
      if (
        (header[18] === 2 || header[19] === 2) &&
        (!sidecars["-wal"] || !sidecars["-shm"])
      )
        throw new RuntimeError(
          "SQLITE_SIDECARS",
          "A live WAL database requires existing WAL and shared-memory sidecars; none will be created.",
          409,
        );
      if (sidecars["-journal"] && BigInt(sidecars["-journal"].size) > 0n)
        throw new RuntimeError(
          "SQLITE_RECOVERY_REQUIRED",
          "The harness must finish database recovery before a read-only read.",
          409,
        );
      if (signal.aborted) throw cancelledRead(signal);
      const main = fileState(before);
      /**
       * Check grant/descriptor identity after SQLite access. Shared-memory coordination
       * is not a content-change signal, but sidecar replacement is an explicit failure.
       */
      const verify = async (): Promise<boolean> => {
        await this.inspect(grant);
        if (!(await pointsToOpenedFile(candidate, canonical, before)))
          throw new RuntimeError(
            "SOURCE_CHANGED",
            "Database identity changed during the read.",
            409,
          );
        const now = await handle.stat({ bigint: true });
        let changed = !sameFileState(before, now);
        let totalSize = now.size;
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          const previous = sidecars[suffix];
          const current = await inspectSidecar(canonical + suffix);
          totalSize += BigInt(current?.size ?? 0);
          if (
            (previous === null) !== (current === null) ||
            (previous &&
              current &&
              (previous.dev !== current.dev || previous.ino !== current.ino))
          )
            throw new RuntimeError(
              "SOURCE_CHANGED",
              "Database sidecar identity changed during the read.",
              409,
            );
          if (
            suffix !== "-shm" &&
            previous &&
            current &&
            (previous.size !== current.size ||
              previous.mtime !== current.mtime ||
              previous.ctime !== current.ctime)
          )
            changed = true;
        }
        if (totalSize > BigInt(MAX_SOURCE_BYTES))
          throw new RuntimeError(
            "SOURCE_TOO_LARGE",
            "Database and sidecars exceed the source limit.",
            413,
          );
        return changed;
      };
      await verify();
      return {
        path: canonical,
        main,
        sidecars: Object.freeze(sidecars),
        startedAtMs,
        verify,
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close();
      filesystemError(error);
    }
  }
}
