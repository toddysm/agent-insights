/** Bounded virtual storage for Copilot session state; never reads or writes the host filesystem. */
import path from "node:path";
import type { SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";

export const SESSION_MEMORY_LIMIT = 8 * 1024 * 1024;
const ENTRY_LIMIT = 512;

/** Undefined content identifies a directory; file content and timestamps belong only to this run. */
interface Entry {
  readonly content: string | undefined;
  readonly createdMs: number;
  readonly modifiedMs: number;
}

/** One run's text-only virtual filesystem, with no SQLite, binary data or host-path fallback. */
export class MemorySessionFilesystem implements SessionFsProvider {
  private readonly entries = new Map<string, Entry>([
    [
      "/",
      { content: undefined, createdMs: Date.now(), modifiedMs: Date.now() },
    ],
  ]);
  private bytes = 0;
  private disposed = false;

  /** Reject use after disposal and normalize bounded absolute virtual paths, not host paths. */
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

  /** Report missing entries through the SDK's recognized ENOENT contract without exposing paths. */
  private entry(key: string): Entry {
    const entry = this.entries.get(key);
    if (!entry)
      throw Object.assign(new Error("Virtual session entry is missing."), {
        code: "ENOENT",
      });
    return entry;
  }

  /** Require an existing virtual directory instead of treating a file as a parent. */
  private directory(key: string): void {
    if (this.entry(key).content !== undefined)
      throw new Error("Virtual session entry is not a directory.");
  }

  /** Atomically enforce the text/entry limits before replacing a file's content. */
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

  /** Read existing text; directories and absent paths reject rather than returning empty content. */
  async readFile(value: string): Promise<string> {
    const entry = this.entry(this.key(value));
    if (entry.content === undefined)
      throw new Error("Cannot read a virtual directory as text.");
    return entry.content;
  }

  /** Replace text after preparing virtual parents; no target mutation occurs on a failed write. */
  async writeFile(value: string, content: string): Promise<void> {
    const key = this.key(value);
    this.makeDirectory(path.posix.dirname(key), true);
    this.store(key, content);
  }

  /** Append within the same byte limit, checking before allocating the combined string. */
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

  /** Check only this run's virtual entries; no native filesystem lookup occurs. */
  async exists(value: string): Promise<boolean> {
    return this.entries.has(this.key(value));
  }

  /** Return virtual metadata; byte sizes measure UTF-8 content, not character counts. */
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

  /** Create bounded virtual directories; nonrecursive calls require their parent to exist. */
  async mkdir(value: string, recursive: boolean): Promise<void> {
    this.makeDirectory(this.key(value), recursive);
  }

  /** Keep directory creation synchronous so concurrent RPC calls cannot overwrite an intervening file. */
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

  /** List direct children only; missing paths and files are not empty directories. */
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

  /** Preserve file/directory distinctions without consulting host metadata. */
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

  /** Remove owned entries; only force permits a missing path and only recursive permits children. */
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

  /** Move a virtual subtree, permitting atomic replacement of files but not occupied directories. */
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

  /** Drop all references and reject later operations after the owning runtime has stopped. */
  dispose(): void {
    this.entries.clear();
    this.bytes = 0;
    this.disposed = true;
  }
}
