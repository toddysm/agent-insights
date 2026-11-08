/**
 * Explicit release downloads into owned staging, followed by existing offline verification and preparation.
 * Only the maintainer CLI supplies trust pins; runtime reads never import this network/writer module.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactError,
  containedPath,
  executableName,
  installedParts,
  nativeManifestSchema,
  nativeTarget,
  nativeUnavailable,
  NATIVE_POLICY,
  sha256,
} from "../runtime/native-helper.js";
import {
  NATIVE_RELEASE,
  type NativeReleasePin,
} from "../runtime/native-release.js";
import { ensureDirectories, prepareArtifact } from "./preparation.js";

/** Normalize only failures from fetch/body I/O; do not expose transport URLs or private diagnostics. */
function downloadFailure(error: unknown): never {
  if (
    error instanceof Error &&
    ["AbortError", "TimeoutError"].includes(error.name)
  )
    throw nativeUnavailable(
      "Native helper download was cancelled or timed out.",
    );
  if (error instanceof TypeError)
    throw nativeUnavailable(
      "Native helper release download failed. Retry explicit preparation.",
    );
  throw error;
}

/** Follow at most three HTTPS redirects within GitHub's fixed release transport, without credentials. */
async function releaseResponse(
  initial: string,
  signal: AbortSignal,
): Promise<Response> {
  let url = new URL(initial);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      ![
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(url.hostname)
    )
      throw nativeUnavailable("Native helper release redirect is not trusted.");
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
        },
      });
    } catch (error) {
      return downloadFailure(error);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 3)
        throw nativeUnavailable("Native helper release redirect is invalid.");
      try {
        url = new URL(location, url);
      } catch (error) {
        if (error instanceof TypeError)
          throw nativeUnavailable("Native helper release redirect is invalid.");
        throw error;
      }
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw nativeUnavailable(
        "Pinned native helper release asset is unavailable. Retry explicit preparation.",
      );
    }
    return response;
  }
  throw nativeUnavailable("Native helper release redirect limit exceeded.");
}

/** Read exactly the independently trusted byte count and digest, including responses without Content-Length. */
async function downloadAsset(
  asset: string,
  bytes: number,
  digest: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await releaseResponse(
    NATIVE_RELEASE.downloadBase + asset,
    signal,
  );
  const length = response.headers.get("content-length");
  if (length !== null && length !== String(bytes)) {
    await response.body?.cancel();
    throw nativeUnavailable("Native helper release download length mismatch.");
  }
  const body = response.body;
  if (!body)
    throw nativeUnavailable("Native helper release download has no body.");
  const reader = body.getReader();
  const output = Buffer.alloc(bytes);
  let offset = 0;
  let complete = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        complete = true;
        return downloadFailure(error);
      }
      if (chunk.done) {
        complete = true;
        break;
      }
      signal.throwIfAborted();
      if (chunk.value.length > bytes - offset)
        throw nativeUnavailable(
          "Native helper release download exceeds its bound.",
        );
      output.set(chunk.value, offset);
      offset += chunk.value.length;
    }
    if (offset !== bytes || sha256(output) !== digest)
      throw nativeUnavailable(
        "Native helper release download checksum mismatch.",
      );
    return output;
  } finally {
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * Download one caller-trusted pin from the fixed release, then atomically prepare its verified bytes.
 * Existing installations are checked offline and never repaired; failure/cancellation removes only owned staging.
 * The caller owns the application root and independent pin, never a browser/model-selected URL or path.
 */
export async function prepareReleasedArtifact(
  root: string,
  pin: NativeReleasePin,
  signal?: AbortSignal,
): Promise<string> {
  let stage: string | undefined;
  try {
    signal?.throwIfAborted();
    if (nativeTarget() !== pin.target)
      throw nativeUnavailable(
        "Native helper release target is not supported on this machine.",
      );
    const finalParts = installedParts(pin);
    if (
      !Number.isSafeInteger(pin.manifestBytes) ||
      pin.manifestBytes < 1 ||
      pin.manifestBytes > NATIVE_POLICY.maxMetadataBytes
    )
      throw nativeUnavailable("Invalid native helper release metadata bound.");
    let existing = false;
    try {
      await containedPath(root, finalParts, true);
      existing = true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    if (existing) return await prepareArtifact(root, finalParts, pin, signal);
    const parent = await ensureDirectories(root, finalParts.slice(0, -1));
    stage = await mkdtemp(path.join(parent, ".downloading-"));
    const parts = [...finalParts.slice(0, -1), path.basename(stage)];
    const downloadSignal = AbortSignal.any(
      signal
        ? [signal, AbortSignal.timeout(90_000)]
        : [AbortSignal.timeout(90_000)],
    );
    const raw = await downloadAsset(
      `manifest-${pin.target}.json`,
      pin.manifestBytes,
      pin.manifestSha256,
      downloadSignal,
    );
    const manifest = nativeManifestSchema.parse(
      JSON.parse(raw.toString("utf8")),
    );
    if (
      manifest.target !== pin.target ||
      manifest.sourceCommit !== NATIVE_RELEASE.sourceCommit
    )
      throw nativeUnavailable(
        "Native helper release provenance is incompatible.",
      );
    await writeFile(path.join(stage, "manifest.json"), raw, {
      flag: "wx",
      mode: 0o600,
    });
    for (const [asset, filename, metadata] of [
      [
        `agent-insights-sqlite-helper-${pin.target}${pin.target === "x86_64-pc-windows-msvc" ? ".exe" : ""}`,
        executableName(pin.target),
        manifest.binary,
      ],
      [
        `THIRD-PARTY-NOTICES-${pin.target}.txt`,
        "THIRD-PARTY-NOTICES.txt",
        manifest.notices,
      ],
    ] as const) {
      const data = await downloadAsset(
        asset,
        metadata.bytes,
        metadata.sha256,
        downloadSignal,
      );
      await containedPath(root, parts, true);
      await writeFile(path.join(stage, filename), data, {
        flag: "wx",
        mode: 0o600,
      });
    }
    return await prepareArtifact(root, parts, pin, downloadSignal);
  } catch (error) {
    return artifactError(error);
  } finally {
    if (stage !== undefined) await rm(stage, { recursive: true });
  }
}
