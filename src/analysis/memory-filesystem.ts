/**
 * Implement the SDK's session-file operations entirely in memory.
 *
 * Copilot can request transcript/workspace-style files while executing an analysis.
 * Routing those operations here avoids staging selected evidence or model responses
 * in host files. The original harness captures are owned/read elsewhere.
 *
 * Paths use virtual POSIX conventions even on Windows. This module implements only
 * the text and directory operations required by the provider: no host filesystem
 * access, binary-file support, permission modes or SQLite storage is provided.
 */
/* eslint-disable @typescript-eslint/require-await -- SDK methods must reject asynchronously while in-memory mutations stay atomic, without artificial yields. */
import path from "node:path";
import type { SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";

/** Maximum UTF-8 file-content bytes, not a bound on total JavaScript/process memory. */
export const SESSION_MEMORY_LIMIT = 8 * 1024 * 1024;
const ENTRY_LIMIT = 512;

/**
 * Private virtual entry owned by one analysis run.
 * Undefined content denotes a directory. These timestamps describe virtual storage
 * operations, not when the original agent session's evidence was captured.
 */
interface Entry {
  readonly content: string | undefined;
  readonly createdMs: number;
  readonly modifiedMs: number;
}

/**
 * One run's bounded text-only filesystem, initialized with an empty virtual root.
 * A map holds entries; no method falls back to host storage when an entry is missing.
 *
 * Public methods are asynchronous to match the SDK interface, but mutations do not
 * yield midway through an operation. Content and entry limits are enforced locally.
 * The owner must retain this instance until its SDK process stops, then dispose it.
 */
export class MemorySessionFilesystem implements SessionFsProvider {
  private readonly entries = new Map<string, Entry>([
    [
      "/",
      { content: undefined, createdMs: Date.now(), modifiedMs: Date.now() },
    ],
  ]);
  private bytes = 0;
  private disposed = false;

  /**
   * Normalize a path in this virtual namespace, without resolving a host filesystem path.
   * @param value - Absolute POSIX path of at most 4,096 string characters, without NUL.
   * @returns Normalized key with a single root representation and no trailing slash.
   * @throws Error for invalid input or use after disposal.
   */
  private key(value: string): string {
    if (
      this.disposed ||
      !value.startsWith("/") ||
      value.length > 4096 ||
      value.includes("\0")
    )
      throw new Error("Invalid or closed virtual session filesystem.");
    return path.posix.normalize(value).replace(/\/$/, "") || "/";
  }

  /**
   * Retrieve a private entry without substituting empty content for a missing file.
   * @param key - Already-normalized virtual path.
   * @returns The owned read-only entry record; callers must not mutate its metadata.
   * @throws Error with code ENOENT if absent, for the SDK adapter to translate.
   */
  private entry(key: string): Entry {
    const entry = this.entries.get(key);
    if (!entry)
      throw Object.assign(new Error("Virtual session entry is missing."), {
        code: "ENOENT",
      });
    return entry;
  }

  /**
   * Check a parent/directory precondition without creating entries.
   * @param key - Already-normalized virtual path expected to name a directory.
   * @throws ENOENT for a missing entry, or Error when the entry is a file.
   */
  private directory(key: string): void {
    if (this.entry(key).content !== undefined)
      throw new Error("Virtual session entry is not a directory.");
  }

  /**
   * Store a file only after validating its replacement size and entry budget.
   * @param key - Normalized file path whose parent the caller has prepared.
   * @param content - Complete replacement text; its UTF-8 byte length drives accounting.
   * @throws Error for directory replacement or exceeded limits. An existing file's
   * contents and accounting remain unchanged when this check rejects.
   */
  private store(key: string, content: string): void {
    const old = this.entries.get(key);
    if (old && old.content === undefined)
      throw new Error("Cannot overwrite a virtual directory with a file.");
    const bytes =
      this.bytes -
      Buffer.byteLength(old?.content ?? "") +
      Buffer.byteLength(content);
    if (
      bytes > SESSION_MEMORY_LIMIT ||
      (!old && this.entries.size >= ENTRY_LIMIT)
    )
      throw new Error("Copilot session memory limit exceeded.");
    this.entries.set(key, {
      content,
      createdMs: old?.createdMs ?? Date.now(),
      modifiedMs: Date.now(),
    });
    this.bytes = bytes;
  }

  /**
   * Read text from this run's virtual store.
   * @param value - Absolute virtual file path; it is never opened on the host.
   * @returns Resolves with complete stored text, including a valid empty string.
   * Missing paths, directory reads and invalid/disposed paths reject.
   */
  async readFile(value: string): Promise<string> {
    const entry = this.entry(this.key(value));
    if (entry.content === undefined)
      throw new Error("Cannot read a virtual directory as text.");
    return entry.content;
  }

  /**
   * Create or replace a virtual text file, preparing parent directories if needed.
   * @param value - Absolute virtual destination, not a native source path.
   * @param content - Complete replacement text, charged against the content-byte limit.
   * @returns Resolves after the write; invalid paths, conflicting directories or limits
   * reject. Parent creation can precede a failure, but a failed target write does not
   * replace its previous file contents.
   */
  async writeFile(value: string, content: string): Promise<void> {
    const key = this.key(value);
    this.makeDirectory(path.posix.dirname(key), true);
    this.store(key, content);
  }

  /**
   * Append text, creating the file and virtual parents when absent.
   * @param value - Absolute virtual file path.
   * @param content - Suffix text; the aggregate byte budget is checked before concatenation.
   * @returns Resolves after append; directory targets, invalid/disposed paths and
   * exceeded content/entry budgets reject without replacing existing file text.
   */
  async appendFile(value: string, content: string): Promise<void> {
    const key = this.key(value);
    if (this.bytes + Buffer.byteLength(content) > SESSION_MEMORY_LIMIT)
      throw new Error("Copilot session memory limit exceeded.");
    this.makeDirectory(path.posix.dirname(key), true);
    const old = this.entries.get(key);
    if (old && old.content === undefined)
      throw new Error("Cannot append to a virtual directory.");
    this.store(key, (old?.content ?? "") + content);
  }

  /**
   * Check existence without accessing native filesystem metadata.
   * @param value - Absolute path in this virtual namespace.
   * @returns True for a file or directory, false for a valid missing path.
   * Invalid paths or a disposed store reject rather than being treated as missing.
   */
  async exists(value: string): Promise<boolean> {
    return this.entries.has(this.key(value));
  }

  /**
   * Describe an existing virtual entry.
   * @param value - Absolute virtual file/directory path.
   * @returns SDK metadata with UTF-8 content size and ISO timestamps; directory size
   * is zero. Missing/invalid paths reject. No host file information is consulted.
   */
  async stat(value: string): Promise<SessionFsFileInfo> {
    const entry = this.entry(this.key(value));
    return {
      isFile: entry.content !== undefined,
      isDirectory: entry.content === undefined,
      size: Buffer.byteLength(entry.content ?? ""),
      mtime: new Date(entry.modifiedMs).toISOString(),
      birthtime: new Date(entry.createdMs).toISOString(),
    };
  }

  /**
   * Ensure a virtual directory exists.
   * @param value - Absolute virtual directory path.
   * @param recursive - When true, create missing ancestors; otherwise require an existing parent.
   * @returns Resolves for a created or already-existing directory. Files, missing
   * nonrecursive parents, disposed paths and exhausted entry capacity reject.
   */
  async mkdir(value: string, recursive: boolean): Promise<void> {
    this.makeDirectory(this.key(value), recursive);
  }

  /**
   * Create directory entries without yielding between validation and mutation.
   * @param key - Normalized virtual directory path.
   * @param recursive - Whether missing ancestors may be created in the same call stack.
   * @throws Error/ENOENT for invalid parent types, missing parents or entry exhaustion.
   * Earlier-created ancestors can remain after an entry-limit failure.
   */
  private makeDirectory(key: string, recursive: boolean): void {
    if (this.entries.has(key)) {
      this.directory(key);
      return;
    }
    const parent = path.posix.dirname(key);
    if (recursive) this.makeDirectory(parent, true);
    else this.directory(parent);
    if (this.entries.size >= ENTRY_LIMIT)
      throw new Error("Copilot session entry limit exceeded.");
    this.entries.set(key, {
      content: undefined,
      createdMs: Date.now(),
      modifiedMs: Date.now(),
    });
  }

  /**
   * List immediate children rather than recursively walking a subtree.
   * @param value - Absolute virtual directory path.
   * @returns A new array of child names; an existing empty directory yields [].
   * Missing entries, files and invalid/disposed paths reject.
   */
  async readdir(value: string): Promise<string[]> {
    const key = this.key(value);
    this.directory(key);
    return [...this.entries.keys()]
      .filter(
        (candidate) =>
          candidate !== key && path.posix.dirname(candidate) === key,
      )
      .map((candidate) => path.posix.basename(candidate));
  }

  /**
   * List immediate children with the SDK's file/directory discriminator.
   * @param value - Absolute virtual directory path.
   * @returns Detached name/type records computed from one synchronous map traversal.
   * Missing entries, files and invalid/disposed paths reject.
   */
  async readdirWithTypes(value: string) {
    const key = this.key(value);
    this.directory(key);
    return [...this.entries.entries()]
      .filter(
        ([candidate]) =>
          candidate !== key && path.posix.dirname(candidate) === key,
      )
      .map(([candidate, entry]) => ({
        name: path.posix.basename(candidate),
        type:
          entry.content === undefined
            ? ("directory" as const)
            : ("file" as const),
      }));
  }

  /**
   * Remove a file or allowed directory subtree and release its content-byte accounting.
   * @param value - Absolute virtual target; the root cannot be removed.
   * @param recursive - Permit removal of descendant entries from a nonempty directory.
   * @param force - Suppress only the missing-target error, not root/type/validation errors.
   * @returns Resolves after removal or an allowed missing-target no-op; other failures reject.
   */
  async rm(value: string, recursive: boolean, force: boolean): Promise<void> {
    const key = this.key(value);
    if (key === "/") throw new Error("Cannot remove the virtual root.");
    if (!this.entries.has(key)) {
      if (!force) this.entry(key);
      return;
    }
    const children = [...this.entries.keys()].filter((candidate) =>
      candidate.startsWith(`${key}/`),
    );
    if (children.length && !recursive)
      throw new Error("Virtual directory is not empty.");
    for (const removed of [key, ...children]) {
      this.bytes -= Buffer.byteLength(this.entry(removed).content ?? "");
      this.entries.delete(removed);
    }
  }

  /**
   * Move an entry and its descendants within this run's namespace.
   * @param source - Existing absolute virtual source path.
   * @param destination - Absolute target whose parent already exists as a directory.
   * @returns Resolves after a move or same-path no-op. Root/descendant moves, oversized
   * resulting paths, conflicting types and replacement of nonempty directories reject
   * before mutation. Existing files or empty matching directories may be replaced.
   */
  async rename(source: string, destination: string): Promise<void> {
    const from = this.key(source);
    const to = this.key(destination);
    const entry = this.entry(from);
    if (from === to) return;
    if (from === "/" || to === "/" || to.startsWith(`${from}/`))
      throw new Error("Invalid virtual session rename.");
    this.directory(path.posix.dirname(to));
    const moved = [...this.entries.entries()].filter(
      ([key]) => key === from || key.startsWith(`${from}/`),
    );
    for (const [key] of moved) this.key(to + key.slice(from.length));
    const existing = this.entries.get(to);
    if (existing) {
      if ((entry.content === undefined) !== (existing.content === undefined))
        throw new Error("Cannot replace a different virtual entry type.");
      if (
        existing.content === undefined &&
        [...this.entries.keys()].some(
          (key) => key !== to && path.posix.dirname(key) === to,
        )
      )
        throw new Error("Cannot replace a nonempty virtual directory.");
      this.bytes -= Buffer.byteLength(existing.content ?? "");
      this.entries.delete(to);
    }
    for (const [key] of moved) this.entries.delete(key);
    for (const [key, value] of moved)
      this.entries.set(to + key.slice(from.length), value);
  }

  /**
   * Release all virtual entries/accounting and permanently close this store.
   * The owning process must already be stopped; this does not terminate the SDK.
   * Repeated disposal is harmless, and subsequent file/directory operations reject.
   */
  dispose(): void {
    this.entries.clear();
    this.bytes = 0;
    this.disposed = true;
  }
}
