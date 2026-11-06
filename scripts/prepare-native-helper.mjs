/**
 * Explicit offline preparation from a locally built/qualified candidate at fixed paths.
 * Default invocation refuses unavailable releases; no URL, executable path or hidden download is accepted.
 */
import assert from "node:assert/strict";
import {
  nativeUnavailable,
  preparedNativeHelper,
} from "../.build/src/runtime/native-helper.js";
import { prepareArtifact } from "../.build/src/native/preparation.js";
import { ROOT, candidateReceipt } from "./native-artifact-tools.mjs";
try {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await preparedNativeHelper();
    console.log("Pinned release helper is prepared.");
  } else {
    assert.deepEqual(
      args,
      ["--candidate"],
      "Only --candidate is supported; arbitrary paths/URLs are not accepted.",
    );
    const receipt = await candidateReceipt();
    const executable = await prepareArtifact(
      ROOT,
      [".build", "native-candidates", receipt.target, receipt.candidate],
      receipt,
    );
    console.log(
      `Prepared verified development candidate at ${executable}. Runtime release selection remains disabled until publication is authorized.`,
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
        "Native helper preparation failed; verify the clean source checkout and rebuild the candidate.",
      ).message,
    );
  process.exitCode = 1;
}
