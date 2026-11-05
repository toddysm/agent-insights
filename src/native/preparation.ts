/**
 * Explicit offline artifact preparation. No application read/refresh path imports or invokes this writer.
 * The caller supplies code-owned trust pins; a package's self-declared checksum is never sufficient.
 */
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  artifactError,
  boundedFile,
  containedPath,
  installedParts,
  nativeHandshakeSchema,
  nativeTarget,
  nativeUnavailable,
  NATIVE_POLICY,
  sha256,
  verifyArtifact,
  type NativeManifest,
  type NativePin,
} from "../runtime/native-helper.js";

/** Create only checked directory components under a caller-authorized application root. */
export async function ensureDirectories(
  root: string,
  parts: readonly string[],
): Promise<string> {
  const canonical = await containedPath(root, [], true);
  let directory = canonical;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[/\\\0]/.test(part))
      throw nativeUnavailable("Invalid native preparation location.");
    directory = path.join(directory, part);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    await containedPath(
      canonical,
      path.relative(canonical, directory).split(path.sep),
      true,
    );
  }
  return directory;
}

/** Run only a preverified binary's source-free check, with bounded output/time and no loader/provider environment. */
export async function checkNativeHandshake(
  executable: string,
  expected: NativeManifest["handshake"],
): Promise<void> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const output = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      executable,
      ["--check"],
      {
        env,
        encoding: "buffer",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || stderr.length)
          reject(nativeUnavailable("Native helper self-check failed."));
        else resolve(stdout);
      },
    );
  });
  if (output.length < 4 || output.readUInt32BE(0) !== output.length - 4)
    throw nativeUnavailable("Native helper handshake frame is invalid.");
  let value: unknown;
  try {
    value = JSON.parse(output.subarray(4).toString("utf8"));
  } catch (error) {
    return artifactError(error);
  }
  const parsed = nativeHandshakeSchema.safeParse(value);
  if (
    !parsed.success ||
    JSON.stringify(parsed.data) !==
      JSON.stringify(nativeHandshakeSchema.parse(expected))
  )
    throw nativeUnavailable("Native helper handshake is incompatible.");
}

/** Install verified bytes into an immutable content-addressed directory, then verify the installed result.
 * Cancellation/failure removes only this attempt's staging directory. Existing installations are never replaced.
 */
export async function prepareArtifact(
  root: string,
  candidateParts: readonly string[],
  pin: NativePin,
  signal?: AbortSignal,
): Promise<string> {
  let stage: string | undefined;
  try {
    signal?.throwIfAborted();
    if (nativeTarget() !== pin.target)
      throw nativeUnavailable(
        "Native helper target is not supported on this machine.",
      );
    const manifest = await verifyArtifact(root, candidateParts, pin);
    const finalParts = installedParts(pin);
    const parent = await ensureDirectories(root, finalParts.slice(0, -1));
    const final = path.join(parent, pin.manifestSha256);
    let existing = false;
    try {
      await lstat(final);
      existing = true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    if (existing) {
      await verifyArtifact(root, finalParts, pin);
      const executable = await containedPath(root, [
        ...finalParts,
        manifest.binary.name,
      ]);
      await checkNativeHandshake(executable, manifest.handshake);
      await verifyArtifact(root, finalParts, pin);
      return executable;
    }
    stage = await mkdtemp(path.join(parent, ".preparing-"));
    const stageParts = [...finalParts.slice(0, -1), path.basename(stage)];
    for (const [name, maximum] of [
      ["manifest.json", NATIVE_POLICY.maxMetadataBytes],
      [manifest.binary.name, NATIVE_POLICY.maxBinaryBytes],
      ["THIRD-PARTY-NOTICES.txt", NATIVE_POLICY.maxNoticesBytes],
    ] as const) {
      signal?.throwIfAborted();
      const bytes = await boundedFile(
        await containedPath(root, [...candidateParts, name]),
        maximum,
      );
      await writeFile(path.join(stage, name), bytes, {
        flag: "wx",
        mode: name === manifest.binary.name ? 0o700 : 0o600,
      });
    }
    await verifyArtifact(root, stageParts, pin);
    const executable = await containedPath(root, [
      ...stageParts,
      manifest.binary.name,
    ]);
    await chmod(executable, 0o700);
    await checkNativeHandshake(executable, manifest.handshake);
    await verifyArtifact(root, stageParts, pin);
    signal?.throwIfAborted();
    // Revalidate the parent location immediately before publishing; no pointer selects partial staging state.
    await containedPath(root, finalParts.slice(0, -1), true);
    try {
      await rename(stage, final);
    } catch (error) {
      // Another explicit preparation may have installed the same immutable object.
      if (!(
        error instanceof Error &&
        "code" in error &&
        ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code))
      ))
        throw error;
      await verifyArtifact(root, finalParts, pin);
      await rm(stage, { recursive: true });
    }
    stage = undefined;
    await verifyArtifact(root, finalParts, pin);
    return containedPath(root, [...finalParts, manifest.binary.name]);
  } catch (error) {
    if (stage !== undefined) await rm(stage, { recursive: true });
    return artifactError(error);
  }
}

/** Verify a metadata checksum before decoding an explicitly built candidate receipt. */
export function candidatePin(target: string, manifest: Buffer): NativePin {
  return { target, manifestSha256: sha256(manifest) };
}
