/** Read-only access to startup-authorized locations; no scanning, writes or retained byte cache. */
import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
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

  /** Read an authorized regular file prefix through a read-only descriptor; reject escapes before reading bytes. */
  async read(
    sourceId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<CapturedSource> {
    const startedAtMs = Date.now();
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
}
