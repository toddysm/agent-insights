/** Read-only access to explicitly configured locations; bounded captures/borrowed streams, no writes or byte cache. */
import { constants } from "node:fs";
import {
  access,
  open,
  realpath,
  stat,
  lstat,
  opendir,
  type FileHandle,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { RuntimeError, abortable, cancelledRead, filesystemError } from "./errors.js";
import type { AddLocationRequest, SourceLocation } from "./protocol.js";

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
 * Borrowed descriptor with a fixed admitted prefix. The callback must finish all
 * iteration before returning; SourceAccess owns acquisition and confirmed closure.
 * Repeated passes are positional and never chase a growing writer.
 */
export interface StreamedSource {
  readonly identity: FileState;
  readonly boundary: number;
  readonly startedAtMs: number;
  /** Re-read the admitted prefix in bounded chunks; premature EOF and cancellation reject. */
  chunks(): AsyncIterable<Uint8Array>;
  /**
   * Revalidate grant/locator/descriptor identity. `changed` compares admission or
   * the previous successful verification; call serially. `appended` compares the
   * admitted boundary. Metadata stability does not replace a prefix digest.
   */
  verify(): Promise<{ changed: boolean; appended: boolean }>;
}

/**
 * Borrow a bounded capture in at most 64 KiB views, rejecting cancellation before each yield.
 * Readers must not mutate/persist these views; they are not live filesystem handles.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Borrowed in-memory bytes retain the reader's asynchronous iteration contract.
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

/** Compare admitted main/sidecar identities without exposing paths or treating metadata stability as an atomic snapshot. */
export function databasePhysicalIdentity(lease: DatabaseLease): string {
  return JSON.stringify([
    lease.main.dev, lease.main.ino,
    Object.entries(lease.sidecars).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, state]) => [name, state ? [state.dev, state.ino] : null]),
  ]);
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
  private readonly failedClosures = new Set<() => Promise<void>>();
  private admission: Promise<void> = Promise.resolve();
  /** Own the initial grant array; subsequent append-only admissions retain every existing grant ID and binding. */
  private constructor(private readonly grants: SourceGrant[]) {}

  /** Own rejected descriptor closes even when admission never returns a lease; never expose raw close errors. */
  private ownClose(handle: FileHandle): () => Promise<void> {
    let completion: Promise<void> | undefined;
    /** Share in-flight/successful closure; only a rejected close can be retried. */
    const close = (): Promise<void> =>
      (completion ??= Promise.resolve()
        .then(() => handle.close())
        .then(
          () => {
            this.failedClosures.delete(close);
          },
          () => {
            this.failedClosures.add(close);
            completion = undefined;
            throw new RuntimeError(
              "SOURCE_CLEANUP_FAILED",
              "A source descriptor could not be closed; retry cleanup before reading again.",
              500,
            );
          },
        ));
    return close;
  }

  /** Retry only failed closes, not live leases owned by other reads; retain failures and bound confirmation to five seconds. */
  async retryCleanup(): Promise<void> {
    if (!this.failedClosures.size) return;
    const cleanup = Promise.allSettled(
      [...this.failedClosures].map((close) => close()),
    ).then((results) => {
      if (results.some((result) => result.status === "rejected"))
        throw new RuntimeError(
          "SOURCE_CLEANUP_FAILED",
          "Source descriptors remain unclosed; retry cleanup before reading again.",
          500,
        );
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RuntimeError(
                  "SOURCE_CLEANUP_FAILED",
                  "Source descriptor cleanup could not be confirmed; retry cleanup.",
                  500,
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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
    return new SourceAccess(grants);
  }

  /**
   * Admit an explicit absolute file/folder path for this runtime only, without reading bytes.
   * Serialize validation/commit so duplicate canonical roots and the 32-location ceiling
   * remain correct under concurrent requests. Existing grants are never rebound.
   * Optional preparation runs before commit; its failure/cancellation leaves grants unchanged.
   * Revalidate the supplied path after preparation. Cancelled work releases its queue
   * slot after its predecessor, but remains observed and cannot register a late grant.
   * Return detached metadata for the final grant and any alias rejected after preparation.
   */
  async add(
    selection: AddLocationRequest,
    signal: AbortSignal,
    prepare?: () => Promise<void>,
  ): Promise<SourceLocation & { readonly rejectedAlias: SourceLocation | null }> {
    const request = Object.freeze({ ...selection });
    const predecessor = this.admission;
    const admit = predecessor.then(async () => {
      if (signal.aborted) throw cancelledRead(signal);
      if (
        !path.isAbsolute(request.path) ||
        request.path.length > 4096 ||
        request.path.includes("\0")
      )
        throw new RuntimeError(
          "INVALID_LOCATION",
          "Enter the full path to an existing file or folder on this computer.",
          400,
        );
      const requested = path.resolve(request.path);
      let canonical: string;
      let identity: BigIntStats;
      try {
        canonical = await realpath(requested);
        const before = await stat(canonical, { bigint: true });
        identity = before;
        if (
          (request.kind === "file" && !before.isFile()) ||
          (request.kind === "directory" && !before.isDirectory())
        )
          throw new RuntimeError(
            "LOCATION_TYPE",
            "The path does not match the selected file or folder type. Correct the path or type.",
            400,
          );
        await access(canonical, constants.R_OK | (request.kind === "directory" ? constants.X_OK : 0));
        const after = await stat(canonical, { bigint: true });
        if ((await realpath(requested)) !== canonical || before.dev !== after.dev || before.ino !== after.ino)
          throw new RuntimeError("ROOT_CHANGED", "The location changed while checking access. Check the path and add it again.", 409);
      } catch (error) {
        filesystemError(error);
      }
      if (signal.aborted) throw cancelledRead(signal);
      let reusable: SourceGrant | undefined;
      for (const existing of this.grants.filter((grant) => grant.canonical === canonical && grant.kind === request.kind)) {
        if ((await this.reuseFailure(existing)) === null) {
          reusable = existing;
          break;
        }
      }
      if (signal.aborted) throw cancelledRead(signal);
      if (!reusable && this.grants.length >= 32)
        throw new RuntimeError("LOCATION_LIMIT", "At most 32 file or folder locations can be configured for this app run.", 400);
      await prepare?.();
      if (signal.aborted) throw cancelledRead(signal);
      let rejectedAlias: SourceLocation | null = null;
      try {
        await this.inspect({ requested, canonical, kind: request.kind });
        if (reusable) {
          const failure = await this.reuseFailure(reusable);
          if (failure) {
            rejectedAlias = { id: reusable.id, path: reusable.requested, kind: reusable.kind, available: false, reason: failure.message };
            reusable = undefined;
          }
        }
        const current = await stat(canonical, { bigint: true });
        if (current.dev !== identity.dev || current.ino !== identity.ino)
          throw new RuntimeError("ROOT_CHANGED", "The location changed while checking access. Check the path and add it again.", 409);
      } catch (error) {
        filesystemError(error);
      }
      if (signal.aborted) throw cancelledRead(signal);
      if (!reusable && this.grants.length >= 32)
        throw new RuntimeError("LOCATION_LIMIT", "At most 32 file or folder locations can be configured for this app run.", 400);
      const grant = reusable ?? { id: `source-${this.grants.length + 1}`, requested, canonical, kind: request.kind };
      if (!reusable) this.grants.push(grant);
      return { id: grant.id, path: grant.requested, kind: grant.kind, available: true, reason: null, rejectedAlias };
    });
    const result = abortable(admit, signal);
    // Preserve earlier admissions even if this request is cancelled while still queued.
    this.admission = Promise.allSettled([predecessor, result]).then(() => undefined);
    return result;
  }

  /** Return the controlled alias failure, or null when reusable; unexpected inspection errors propagate. */
  private async reuseFailure(grant: SourceGrant): Promise<RuntimeError | null> {
    try {
      await this.inspect(grant);
      return null;
    } catch (error) {
      if (!(error instanceof RuntimeError) || !["ROOT_CHANGED", "SOURCE_MISSING", "SOURCE_DENIED", "SOURCE_LINK", "SOURCE_IO"].includes(error.code)) throw error;
      return error;
    }
  }

  /** Recheck a grant without silently authorizing a replacement symlink or a changed root kind. */
  private async inspect(grant: Omit<SourceGrant, "id">): Promise<void> {
    if (grant.kind === "unknown") {
      throw new RuntimeError(
        "SOURCE_UNAVAILABLE",
        "Unavailable at startup. Correct the path or restore access, then use Add a file or folder to add it explicitly.",
        404,
      );
    }
    try {
      if ((await realpath(grant.requested)) !== grant.canonical) {
        throw new RuntimeError(
          "ROOT_CHANGED",
          "The configured location changed its target. Use Add a file or folder to select the new location explicitly.",
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
          "The configured location changed its type. Use Add a file or folder to select it explicitly.",
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
    kind: "file" | "directory" = "file",
  ): Promise<{
    grant: SourceGrant;
    canonical: string;
    candidate: string;
  }> {
    if (this.failedClosures.size)
      throw new RuntimeError(
        "SOURCE_CLEANUP_FAILED",
        "Retry failed source cleanup before reading again.",
        503,
      );
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
      const info = await stat(canonical);
      if (kind === "file" ? !info.isFile() : !info.isDirectory()) {
        throw new RuntimeError(
          kind === "file" ? "NOT_A_FILE" : "NOT_A_DIRECTORY",
          kind === "file" ? "Select a regular capture file." : "Select an approved source directory.",
          400,
        );
      }
      if (signal.aborted) throw cancelledRead(signal);
      return { grant, canonical, candidate };
    } catch (error) {
      filesystemError(error);
    }
  }

  /** Inspect an explicitly selected regular file/directory through the same confined admission checks as reads. */
  async kind(sourceId: string, relativePath: string, signal: AbortSignal): Promise<"file" | "directory"> {
    try {
      await this.resolve(sourceId, relativePath, signal);
      return "file";
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== "NOT_A_FILE") throw error;
    }
    await this.resolve(sourceId, relativePath, signal, "directory");
    return "directory";
  }

  /**
   * List one approved directory, never recursively or through child links.
   * Return links as distinct entries so callers can report their exclusion without following them.
   * Reject over 256 entries rather than silently truncating discovery. Revalidate
   * its locator after iteration; callers must still admit each selected file.
   */
  async entries(
    sourceId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<readonly { name: string; kind: "file" | "directory" | "link" }[]> {
    const { canonical } = await this.resolve(sourceId, relativePath, signal, "directory");
    try {
      const before = await stat(canonical, { bigint: true });
      const directory = await opendir(canonical);
      const entries: { name: string; kind: "file" | "directory" | "link" }[] = [];
      let count = 0;
      for await (const entry of directory) {
        if (signal.aborted) throw cancelledRead(signal);
        if (++count > 256)
          throw new RuntimeError("DISCOVERY_LIMIT", "A discovery directory exceeds 256 entries; select a narrower root.", 413);
        if (entry.isSymbolicLink())
          entries.push({ name: entry.name, kind: "link" });
        else if (entry.isFile() || entry.isDirectory())
          entries.push({ name: entry.name, kind: entry.isFile() ? "file" : "directory" });
      }
      const after = await this.resolve(sourceId, relativePath, signal, "directory");
      if (after.canonical !== canonical || !sameFileState(before, await stat(canonical, { bigint: true })))
        throw new RuntimeError("SOURCE_CHANGED", "A discovery directory changed; refresh its sources.", 409);
      return entries.sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      filesystemError(error);
    }
  }

  /**
   * Reject links below an explicitly selected discovery directory, including
   * generated filenames and intermediate components. The selected root itself
   * may be an explicit alias. Call before/after acquisition: metadata checks do
   * not claim an atomic filesystem snapshot or a sandbox against concurrent changes.
   */
  async verifyDiscoveryPath(sourceId: string, rootPath: string, relativePath: string, signal: AbortSignal): Promise<void> {
    const root = await this.resolve(sourceId, rootPath, signal, "directory");
    const candidate = path.resolve(root.grant.canonical, relativePath);
    if (!contains(root.candidate, candidate))
      throw new RuntimeError("SOURCE_SCOPE", "A generated discovery path escapes its selected root.", 403);
    try {
      let current = root.canonical;
      for (const component of path.relative(root.candidate, candidate).split(path.sep).filter(Boolean)) {
        if (signal.aborted) throw cancelledRead(signal);
        const next = path.join(current, component);
        if ((await lstat(next)).isSymbolicLink())
          throw new RuntimeError("SOURCE_LINK", "Generated discovery paths cannot follow child links; select an alias explicitly.", 403);
        current = await realpath(next);
        if (!contains(root.canonical, current))
          throw new RuntimeError("SOURCE_LINK", "A generated discovery path leaves its selected root.", 403);
      }
      if (await realpath(root.candidate) !== root.canonical || await realpath(candidate) !== current)
        throw new RuntimeError("SOURCE_CHANGED", "A discovery path changed; refresh its sources.", 409);
      if (signal.aborted) throw cancelledRead(signal);
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
      const close = this.ownClose(handle);
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
        await close();
      }
    } catch (error) {
      filesystemError(error);
    }
  }

  /**
   * Borrow an authorized original descriptor without whole-file allocation or a file-size ceiling.
   * The returned promise owns even late acquisition and rejected closes; cancelling
   * a wait is not cleanup. Callers must retain settlement and use the publication barrier.
   * Metadata and record/work budgets belong to the borrower, not this authorization layer.
   */
  async withStream<T>(
    sourceId: string,
    relativePath: string,
    signal: AbortSignal,
    borrow: (source: StreamedSource) => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) throw cancelledRead(signal);
    const startedAtMs = Date.now();
    const { grant, canonical, candidate } = await this.resolve(sourceId, relativePath, signal);
    try {
      const handle = await open(canonical, constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      const close = this.ownClose(handle);
      try {
        if (signal.aborted) throw cancelledRead(signal);
        const before = await handle.stat({ bigint: true });
        if (!before.isFile())
          throw new RuntimeError("NOT_A_FILE", "Select a regular capture file.", 400);
        if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
          throw new RuntimeError("SOURCE_TOO_LARGE", "The source exceeds safe byte-coordinate limits.", 413);
        if (!(await pointsToOpenedFile(candidate, canonical, before)))
          throw new RuntimeError("SOURCE_CHANGED", "The source changed while opening; refresh and retry.", 409);
        if (signal.aborted) throw cancelledRead(signal);
        const boundary = Number(before.size);
        let lastVerified = before;
        const source: StreamedSource = {
          identity: fileState(before), boundary, startedAtMs,
          async *chunks() {
            for (let position = 0; position < boundary;) {
              if (signal.aborted) throw cancelledRead(signal);
              const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, boundary - position));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
              if (signal.aborted) throw cancelledRead(signal);
              if (!bytesRead)
                throw new RuntimeError("SOURCE_CHANGED", "The admitted source prefix was truncated; refresh and retry.", 409);
              position += bytesRead;
              yield buffer.subarray(0, bytesRead);
            }
          },
          verify: async () => {
            if (signal.aborted) throw cancelledRead(signal);
            await this.inspect(grant);
            const after = await handle.stat({ bigint: true });
            if (after.size < before.size || !(await pointsToOpenedFile(candidate, canonical, before)))
              throw new RuntimeError("SOURCE_CHANGED", "The source identity or admitted prefix changed; refresh and retry.", 409);
            if (signal.aborted) throw cancelledRead(signal);
            const changed = !sameFileState(lastVerified, after);
            lastVerified = after;
            return { changed, appended: after.size > before.size };
          },
        };
        return await borrow(source);
      } finally {
        await close();
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
    const close = this.ownClose(handle);
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
      if (sidecars["-journal"])
        throw new RuntimeError(
          "SQLITE_JOURNAL_PRESENT",
          "A rollback journal is present. Retry after the producer removes it; retained-journal modes are unsupported.",
          409,
        );
      if (signal.aborted) throw cancelledRead(signal);
      const main = fileState(before);
      /**
       * Check grant/descriptor identity after SQLite access. Shared-memory coordination
       * is not a content-change signal, but sidecar replacement is an explicit failure.
       * Normalize known filesystem errors on every invocation, not only initial admission.
       */
      const verify = async (): Promise<boolean> => {
        try {
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
            if (suffix === "-journal" && current)
              throw new RuntimeError(
                "SQLITE_JOURNAL_PRESENT",
                "A rollback journal appeared during the read.",
                409,
              );
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
        } catch (error) {
          filesystemError(error);
        }
      };
      await verify();
      return {
        path: canonical,
        main,
        sidecars: Object.freeze(sidecars),
        startedAtMs,
        verify,
        close,
      };
    } catch (error) {
      await close();
      filesystemError(error);
    }
  }
}
