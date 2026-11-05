/**
 * Explicitly build and qualify a native candidate from a clean checkout, then emit an independent local trust receipt.
 * This does not publish releases or enable runtime downloads. It requires developer Rust/C tooling.
 */
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { boundedFile } from "../.build/src/runtime/native-helper.js";
import {
  nativeTarget,
  executableName,
  NATIVE_POLICY,
  nativeHandshakeSchema,
  sha256,
  verifyArtifact,
} from "../.build/src/runtime/native-helper.js";
import {
  ensureDirectories,
  checkNativeHandshake,
  candidatePin,
} from "../.build/src/native/preparation.js";
import {
  ROOT,
  CRATE,
  tool,
  sourceIdentity,
  candidateKey,
  dependencyNotices,
  qualification,
} from "./native-artifact-tools.mjs";
import {
  nativeBuildContext,
  qualifyNativeTest,
} from "./native-build-context.mjs";

assert.equal(
  process.argv.length,
  2,
  "This build accepts no arbitrary path, target or version arguments.",
);
const identity = await sourceIdentity();
const key = candidateKey(identity);
const target = nativeTarget();
const parent = await ensureDirectories(ROOT, [
  ".build",
  "native-candidates",
  target,
]);
const destination = path.join(parent, key);
await lstat(destination).then(
  () => {
    throw new Error(
      "Candidate already exists; preserve it or remove that exact owned candidate before rebuilding.",
    );
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
let stage = await mkdtemp(path.join(parent, ".packaging-"));
let context;
try {
  const buildRoot = await ensureDirectories(ROOT, [
    ".build",
    "native-compile",
    key,
  ]);
  context = await nativeBuildContext(ROOT, buildRoot);
  const { env, cwd } = context;
  const rustc = tool(context.rustc, ["--version", "--verbose"], { env, cwd });
  const cargo = tool(context.cargo, ["--version"], { env, cwd });
  assert.ok(rustc.startsWith(`rustc ${NATIVE_POLICY.rustVersion} `));
  assert.ok(
    rustc.split(/\r?\n/).includes(`host: ${target}`),
    "Artifacts must be built and executed on their native host.",
  );
  assert.ok(cargo.startsWith(`cargo ${NATIVE_POLICY.rustVersion} `));
  qualification(
    context.cargo,
    context.args([
      "build",
      "--locked",
      "--release",
      "--no-default-features",
      "--target",
      target,
      "--manifest-path",
      path.join(ROOT, CRATE),
      "--bin",
      "agent-insights-sqlite-helper",
    ]),
    env,
    cwd,
  );
  const binaryName = executableName(target);
  const binary = await boundedFile(
    path.join(buildRoot, target, "release", binaryName),
    NATIVE_POLICY.maxBinaryBytes,
  );
  await writeFile(path.join(stage, binaryName), binary, {
    flag: "wx",
    mode: 0o700,
  });
  await chmod(path.join(stage, binaryName), 0o700);
  const handshake = nativeHandshakeSchema.parse({
    kind: "hello",
    protocolVersion: 1,
    guardVersion: NATIVE_POLICY.guardVersion,
    sqliteSourceId: NATIVE_POLICY.sqliteSourceId,
    target,
    qualificationHooks: false,
    maxRequestBytes: 1048576,
    maxReplyBytes: 25165824,
  });
  await checkNativeHandshake(path.join(stage, binaryName), handshake);
  const metadata = JSON.parse(
    tool(
      context.cargo,
      context.args([
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        target,
        "--manifest-path",
        path.join(ROOT, CRATE),
      ]),
      { env, cwd },
    ),
  );
  const notices = Buffer.from(await dependencyNotices(metadata));
  await writeFile(path.join(stage, "THIRD-PARTY-NOTICES.txt"), notices, {
    flag: "wx",
    mode: 0o600,
  });
  const manifest = {
    formatVersion: 1,
    target,
    ...identity,
    rustVersion: NATIVE_POLICY.rustVersion,
    rustc,
    cargo,
    sqliteSourceId: NATIVE_POLICY.sqliteSourceId,
    sqliteFlags: NATIVE_POLICY.flags,
    qualificationHooks: false,
    binary: { name: binaryName, sha256: sha256(binary), bytes: binary.length },
    notices: { sha256: sha256(notices), bytes: notices.length },
    handshake,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(stage, "manifest.json"), manifestBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const pin = candidatePin(target, manifestBytes);
  await verifyArtifact(
    ROOT,
    [".build", "native-candidates", target, path.basename(stage)],
    pin,
  );
  // Rename once before qualifying: tests execute precisely the packaged path later consumed by preparation.
  await rename(stage, destination);
  stage = undefined;
  const executable = path.join(destination, binaryName);
  const fixtureEnv = { ...env, AGENT_INSIGHTS_TEST_HELPER: executable };
  qualification(
    process.execPath,
    ["--test", "native/sqlite-guard/tests/fixtures/protocol.mjs"],
    fixtureEnv,
  );
  qualifyNativeTest(
    context,
    [
      "test",
      "--locked",
      "--release",
      "--no-default-features",
      "--target",
      target,
      "--manifest-path",
      path.join(ROOT, CRATE),
      "--test",
      "helper_protocol",
    ],
    "parent_loss_exits_while_native_work_and_the_control_channel_remain_open",
    fixtureEnv,
  );
  await verifyArtifact(ROOT, [".build", "native-candidates", target, key], pin);
  assert.deepEqual(
    await sourceIdentity(),
    identity,
    "Source changed while candidate qualification ran",
  );
  const receipt = {
    formatVersion: 1,
    ...pin,
    ...identity,
    candidate: key,
    qualification: {
      passed: true,
      processSuite: "protocol.mjs",
      parentLoss: true,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      runner: process.env.RUNNER_OS ?? "local",
      runnerArch: process.env.RUNNER_ARCH ?? process.arch,
      workflowRun: process.env.GITHUB_RUN_ID ?? null,
      testedAt: new Date().toISOString(),
    },
  };
  const trust = await ensureDirectories(ROOT, [".build", "native-trust"]);
  const temporary = path.join(trust, `${target}-${process.pid}.json`);
  await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path.join(trust, `${target}.json`));
  console.log(
    `Qualified native candidate ${target}; manifest SHA-256 ${pin.manifestSha256}. Not a published release.`,
  );
} finally {
  if (stage !== undefined) await rm(stage, { recursive: true });
  if (context !== undefined) await context.cleanup();
}
