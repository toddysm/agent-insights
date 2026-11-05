/** Re-verify prepared candidate bytes and execute the real process suite against the installed package, never a development fallback. */
import assert from "node:assert/strict";
import {
  inspectPreparedHelper,
  verifyArtifact,
  installedParts,
} from "../.build/src/runtime/native-helper.js";
import {
  ROOT,
  candidateReceipt,
  qualification,
  CRATE,
} from "./native-artifact-tools.mjs";

assert.equal(process.argv.length, 2);
const receipt = await candidateReceipt();
const executable = await inspectPreparedHelper(ROOT, receipt);
const env = { ...process.env, AGENT_INSIGHTS_TEST_HELPER: executable };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
qualification(
  process.execPath,
  ["--test", "native/sqlite-guard/tests/fixtures/protocol.mjs"],
  env,
);
qualification(
  process.execPath,
  ["--test", ".build/tests/native-artifacts.test.js"],
  env,
);
qualification(
  "cargo",
  [
    "test",
    "--locked",
    "--release",
    "--manifest-path",
    CRATE,
    "--test",
    "helper_protocol",
    "parent_loss_exits_while_native_work_and_the_control_channel_remain_open",
  ],
  env,
);
await verifyArtifact(ROOT, installedParts(receipt), receipt);
console.log(
  `Prepared ${receipt.target} candidate passed native subprocess qualification; no publication performed.`,
);
