/**
 * Verify prepared native helpers without downloading, building, spawning or reading session sources.
 * Only code-owned release pins select production artifacts. Candidate trust is an explicit developer workflow.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RuntimeError } from "./errors.js";
import {
  NATIVE_RELEASE_PINS,
  type NativeReleasePin,
} from "./native-release.js";

export const NATIVE_POLICY = Object.freeze({
  protocolVersion: 1,
  guardVersion: "0.1.0",
  sqliteSourceId:
    "2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76",
  rustVersion: "1.91.0",
  flags:
    "-DSQLITE_TEMP_STORE=3 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_MAX_WORKER_THREADS=0 -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_ENABLE_LOCKING_STYLE=0",
  maxBinaryBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
  maxNoticesBytes: 4 * 1024 * 1024,
});
export const NATIVE_TARGETS = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const target = z.enum([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
]);
const fileSchema = z.strictObject({
  sha256: digest,
  bytes: z.number().int().positive(),
});

/** Source-free compatibility response; no unknown fields, test hooks or unsafe number conversion. */
export const nativeHandshakeSchema = z.strictObject({
  kind: z.literal("hello"),
  protocolVersion: z.literal(NATIVE_POLICY.protocolVersion),
  guardVersion: z.literal(NATIVE_POLICY.guardVersion),
  sqliteSourceId: z.literal(NATIVE_POLICY.sqliteSourceId),
  target,
  qualificationHooks: z.literal(false),
  maxRequestBytes: z.literal(1048576),
  maxReplyBytes: z.literal(25165824),
});

/** Metadata is authenticated by an external pin, never by a checksum contained in the same untrusted package. */
export const nativeManifestSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    target,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceTree: digest,
    cargoLockSha256: digest,
    buildPolicySha256: digest,
    toolchainSha256: digest,
    rustVersion: z.literal(NATIVE_POLICY.rustVersion),
    rustc: z.string().min(1).max(2048),
    cargo: z.string().min(1).max(512),
    sqliteSourceId: z.literal(NATIVE_POLICY.sqliteSourceId),
    sqliteFlags: z.literal(NATIVE_POLICY.flags),
    qualificationHooks: z.literal(false),
    binary: fileSchema.extend({
      name: z.enum([
        "agent-insights-sqlite-helper",
        "agent-insights-sqlite-helper.exe",
      ]),
    }),
    notices: fileSchema,
    handshake: nativeHandshakeSchema,
  })
  .superRefine((value, context) => {
    if (
      value.handshake.target !== value.target ||
      value.binary.name !== executableName(value.target) ||
      value.binary.bytes > NATIVE_POLICY.maxBinaryBytes ||
      value.notices.bytes > NATIVE_POLICY.maxNoticesBytes
    )
      context.addIssue({
        code: "custom",
        message: "Artifact metadata is incompatible",
      });
  });
export type NativeManifest = z.infer<typeof nativeManifestSchema>;

/** An independent application-owned digest, not a package-selected executable path or version. */
export interface NativePin {
  readonly target: string;
  readonly manifestSha256: string;
}

/** Fixed errors carry no native paths, command output or source data across the application boundary. */
export function nativeUnavailable(
  message = "No verified native helper is prepared for this platform.",
): RuntimeError {
  return new RuntimeError("NATIVE_GUARD_UNAVAILABLE", message, 503);
}

/** Select only qualified targets; Linux additionally requires the GNU libc runtime used by the build. */
export function nativeTarget(
  platform: string = process.platform,
  arch: string = process.arch,
  glibc?: string,
): NativeManifest["target"] {
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(NATIVE_TARGETS, key))
    throw nativeUnavailable("This platform has no qualified native helper.");
  if (platform === "linux") {
    const report = glibc === undefined ? process.report.getReport() : undefined;
    const header = report && "header" in report ? report.header : undefined;
    const version =
      glibc ??
      (header && typeof header === "object" && "glibcVersionRuntime" in header
        ? header.glibcVersionRuntime
        : undefined);
    if (typeof version !== "string" || !version)
      throw nativeUnavailable(
        "This Linux runtime has no qualified GNU libc helper.",
      );
  }
  return NATIVE_TARGETS[key as keyof typeof NATIVE_TARGETS];
}

/** Fixed filename selected solely from a qualified target. */
export function executableName(
  selected: string,
): "agent-insights-sqlite-helper" | "agent-insights-sqlite-helper.exe" {
  return selected === "x86_64-pc-windows-msvc"
    ? "agent-insights-sqlite-helper.exe"
    : "agent-insights-sqlite-helper";
}

/** Hash bytes already bounded by their owning operation. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Check every existing component below the canonical application root without following links. */
export async function containedPath(
  root: string,
  parts: readonly string[],
  directory = false,
): Promise<string> {
  const canonical = await realpath(root);
  let selected = canonical;
  for (const [index, part] of parts.entries()) {
    if (!part || part === "." || part === ".." || /[/\\\0]/.test(part))
      throw nativeUnavailable("Invalid native artifact location.");
    selected = path.join(selected, part);
    const info = await lstat(selected);
    const wantDirectory = index < parts.length - 1 || directory;
    if (
      info.isSymbolicLink() ||
      (wantDirectory ? !info.isDirectory() : !info.isFile()) ||
      (await realpath(selected)) !== selected
    )
      throw nativeUnavailable(
        "Native artifact locations must not contain links or alternate paths.",
      );
  }
  return selected;
}

/** Read an identity-checked existing regular file within a strict bound; never allocate using unchecked metadata. */
export async function boundedFile(
  filename: string,
  limit: number,
): Promise<Buffer> {
  const before = await lstat(filename, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(limit)
  )
    throw nativeUnavailable("Invalid native artifact file.");
  const file = await open(
    filename,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await file.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw nativeUnavailable("Native artifact changed during verification.");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead)
        throw nativeUnavailable("Native artifact changed during verification.");
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(filename, { bigint: true });
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.size !== opened.size ||
      named.mtimeNs !== opened.mtimeNs ||
      named.ctimeNs !== opened.ctimeNs
    )
      throw nativeUnavailable("Native artifact changed during verification.");
    return bytes;
  } finally {
    await file.close();
  }
}

/** Convert only expected filesystem/format failures into explicit unavailable status; programming bugs still propagate. */
export function artifactError(error: unknown): never {
  if (error instanceof RuntimeError) throw error;
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    throw nativeUnavailable("Native artifact metadata is invalid.");
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  if (
    [
      "ENOENT",
      "ENOTDIR",
      "EACCES",
      "EPERM",
      "ELOOP",
      "EIO",
      "EBUSY",
      "ENOEXEC",
    ].includes(String(code))
  )
    throw nativeUnavailable(
      "Native helper files are missing, inaccessible or changed.",
    );
  throw error;
}

/** Verify all bytes against an independently trusted manifest digest; this function never executes the binary. */
export async function verifyArtifact(
  root: string,
  parts: readonly string[],
  pin: NativePin,
): Promise<NativeManifest> {
  try {
    if (
      !target.safeParse(pin.target).success ||
      !digest.safeParse(pin.manifestSha256).success
    )
      throw nativeUnavailable("Invalid native helper trust pin.");
    const manifestPath = await containedPath(root, [...parts, "manifest.json"]);
    const raw = await boundedFile(manifestPath, NATIVE_POLICY.maxMetadataBytes);
    if (sha256(raw) !== pin.manifestSha256)
      throw nativeUnavailable("Native helper manifest checksum mismatch.");
    const manifest = nativeManifestSchema.parse(
      JSON.parse(raw.toString("utf8")),
    );
    if (manifest.target !== pin.target)
      throw nativeUnavailable("Native helper architecture mismatch.");
    const binary = await boundedFile(
      await containedPath(root, [...parts, manifest.binary.name]),
      NATIVE_POLICY.maxBinaryBytes,
    );
    const notices = await boundedFile(
      await containedPath(root, [...parts, "THIRD-PARTY-NOTICES.txt"]),
      NATIVE_POLICY.maxNoticesBytes,
    );
    if (
      binary.length !== manifest.binary.bytes ||
      sha256(binary) !== manifest.binary.sha256 ||
      notices.length !== manifest.notices.bytes ||
      sha256(notices) !== manifest.notices.sha256
    )
      throw nativeUnavailable("Native helper package checksum mismatch.");
    return manifest;
  } catch (error) {
    return artifactError(error);
  }
}

/** Installation paths are code-owned and content-addressed; package filenames cannot select them. */
export function installedParts(pin: NativePin): string[] {
  if (
    !target.safeParse(pin.target).success ||
    !digest.safeParse(pin.manifestSha256).success
  )
    throw nativeUnavailable("Invalid native helper trust pin.");
  return [".native-helper", pin.target, pin.manifestSha256];
}

/** Validate an installed artifact immediately before trusted runtime launch; no network, build, subprocess or source access. */
export async function inspectPreparedHelper(
  root: string,
  pin: NativePin,
): Promise<string> {
  if (nativeTarget() !== pin.target)
    throw nativeUnavailable("Native helper architecture mismatch.");
  const parts = installedParts(pin);
  const manifest = await verifyArtifact(root, parts, pin);
  try {
    const executable = await containedPath(root, [
      ...parts,
      manifest.binary.name,
    ]);
    await access(executable, constants.X_OK);
    return executable;
  } catch (error) {
    return artifactError(error);
  }
}

/** Select an immutable application-owned release pin; unsupported targets never fall back to candidates. */
export function releasedNativePin(
  selected: string = nativeTarget(),
): NativeReleasePin {
  const pin = NATIVE_RELEASE_PINS.find((entry) => entry.target === selected);
  if (!pin)
    throw nativeUnavailable(
      "No qualified native helper release is pinned for this platform. File-only and analysis features are unchanged.",
    );
  return pin;
}

/** Inspect only installed bytes for the fixed release; missing/tampered preparation never causes a download or repair. */
export async function preparedNativeHelper(): Promise<string> {
  const pin = releasedNativePin();
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  return inspectPreparedHelper(root, pin);
}
