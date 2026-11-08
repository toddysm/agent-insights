/**
 * Explicit preparation from fixed release assets or an offline locally built/qualified candidate.
 * No URL, version, executable override or install lifecycle hook is accepted; reads never invoke this command.
 */
import assert from "node:assert/strict";
import {
  nativeUnavailable,
  preparedNativeHelper,
  releasedNativePin,
} from "../.build/src/runtime/native-helper.js";
import { prepareArtifact } from "../.build/src/native/preparation.js";
import { prepareReleasedArtifact } from "../.build/src/native/release-preparation.js";
import { NATIVE_RELEASE } from "../.build/src/runtime/native-release.js";
import { ROOT, candidateReceipt } from "./native-artifact-tools.mjs";
try {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const pin = releasedNativePin();
    await prepareReleasedArtifact(ROOT, pin);
    await preparedNativeHelper();
    console.log(
      JSON.stringify({
        prepared: true,
        release: NATIVE_RELEASE.tag,
        target: pin.target,
        sourceCommit: NATIVE_RELEASE.sourceCommit,
        manifestSha256: pin.manifestSha256,
      }),
    );
  } else {
    assert.deepEqual(
      args,
      ["--candidate"],
      "Only no arguments or --candidate are supported; arbitrary paths/URLs/versions are not accepted.",
    );
    const receipt = await candidateReceipt();
    const executable = await prepareArtifact(
      ROOT,
      [".build", "native-candidates", receipt.target, receipt.candidate],
      receipt,
    );
    console.log(
      `Prepared verified development candidate at ${executable}. Runtime selection uses only the separately pinned release.`,
    );
  }
} catch (error) {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "NATIVE_GUARD_UNAVAILABLE"
  )
    console.error(`${error.code}: ${error.message}`);
  else
    console.error(
      nativeUnavailable(
        "Native helper preparation failed. Retry explicit release preparation, or verify the clean checkout for --candidate.",
      ).message,
    );
  process.exitCode = 1;
}
