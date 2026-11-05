/** Explicit synthetic runtime/native integration qualification using only the verified installed candidate; never a startup/read hook. */
import assert from "node:assert/strict";
import {
  ROOT,
  candidateReceipt,
  qualification,
} from "./native-artifact-tools.mjs";
import { inspectPreparedHelper } from "../.build/src/runtime/native-helper.js";

assert.equal(
  process.argv.length,
  2,
  "No arbitrary helper paths or versions are accepted",
);
const receipt = await candidateReceipt();
await inspectPreparedHelper(ROOT, receipt);
const env = { ...process.env, AGENT_INSIGHTS_TEST_NATIVE_ROOT: ROOT };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
qualification(
  process.execPath,
  [
    "--test",
    ".build/tests/source-access.test.js",
    ".build/tests/sqlite-transport.test.js",
  ],
  env,
);
await inspectPreparedHelper(ROOT, receipt);
console.log(
  "Shared source-access qualification passed with the verified prepared native candidate.",
);
