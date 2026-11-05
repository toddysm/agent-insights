/** Verify artifact trust, containment and preparation using temporary owned packages; no session sources or downloads. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  NATIVE_POLICY,
  nativeManifestSchema,
  nativeTarget,
  executableName,
  sha256,
  verifyArtifact,
  inspectPreparedHelper,
  preparedNativeHelper,
  installedParts,
  boundedFile,
  type NativeManifest,
  type NativePin,
} from "../src/runtime/native-helper.js";
import { prepareArtifact } from "../src/native/preparation.js";
import { RuntimeError } from "../src/runtime/errors.js";

/** Expect a controlled failure, never an empty/success-shaped unavailable result. */
function unavailable(error: unknown): boolean {
  return (
    error instanceof RuntimeError && error.code === "NATIVE_GUARD_UNAVAILABLE"
  );
}

/** Create a bounded fictional package with an independent trust pin and automatic cleanup. */
async function fixture(
  t: TestContext,
  binary: Buffer = Buffer.from("exit 1\n"),
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "insights-artifact-"));
  t.after(() => rm(root, { recursive: true }));
  const selected = nativeTarget();
  const parts = ["candidate"];
  const directory = path.join(root, ...parts);
  await mkdir(directory);
  const name = executableName(selected);
  const notices = Buffer.from(
    "Synthetic test notices, not a released binary.\n",
  );
  const manifest: NativeManifest = {
    formatVersion: 1,
    target: selected as NativeManifest["target"],
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(64),
    cargoLockSha256: "c".repeat(64),
    buildPolicySha256: "d".repeat(64),
    toolchainSha256: "e".repeat(64),
    rustVersion: "1.91.0",
    rustc: "rustc 1.91.0 synthetic",
    cargo: "cargo 1.91.0 synthetic",
    sqliteSourceId: NATIVE_POLICY.sqliteSourceId,
    sqliteFlags: NATIVE_POLICY.flags,
    qualificationHooks: false,
    binary: { name, bytes: binary.length, sha256: sha256(binary) },
    notices: { bytes: notices.length, sha256: sha256(notices) },
    handshake: {
      kind: "hello",
      protocolVersion: 1,
      guardVersion: "0.1.0",
      sqliteSourceId: NATIVE_POLICY.sqliteSourceId,
      target: selected as NativeManifest["target"],
      qualificationHooks: false,
      maxRequestBytes: 1048576,
      maxReplyBytes: 25165824,
    },
  };
  await writeFile(path.join(directory, name), binary, { mode: 0o700 });
  await writeFile(path.join(directory, "THIRD-PARTY-NOTICES.txt"), notices);
  const raw = Buffer.from(JSON.stringify(manifest) + "\n");
  await writeFile(path.join(directory, "manifest.json"), raw);
  const pin: NativePin = { target: selected, manifestSha256: sha256(raw) };
  return { root, directory, parts, pin, manifest };
}

test("qualified target selection never guesses support or falls back to another binary", () => {
  assert.equal(nativeTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(nativeTarget("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(nativeTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(
    nativeTarget("linux", "x64", "2.39"),
    "x86_64-unknown-linux-gnu",
  );
  assert.throws(() => nativeTarget("linux", "x64", ""), unavailable);
  assert.throws(() => nativeTarget("win32", "arm64"), unavailable);
  assert.throws(() => nativeTarget("freebsd", "x64"), unavailable);
});

test("verification checks independent metadata, binary and notice hashes without running the binary", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await verifyArtifact(f.root, f.parts, f.pin), f.manifest);
  await writeFile(path.join(f.directory, f.manifest.binary.name), "tampered");
  await assert.rejects(verifyArtifact(f.root, f.parts, f.pin), unavailable);
  await assert.rejects(
    verifyArtifact(f.root, f.parts, {
      ...f.pin,
      manifestSha256: "0".repeat(64),
    }),
    unavailable,
  );
});

test("self-signed metadata and traversal/unknown versions never select executable paths", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { formatVersion: 99 },
    { qualificationHooks: true },
    { rustVersion: "1.92.0" },
    { binary: { ...f.manifest.binary, name: "../../foreign" } },
    { handshake: { ...f.manifest.handshake, qualificationHooks: true } },
    { handshake: { ...f.manifest.handshake, protocolVersion: 99 } },
  ]) {
    const raw = Buffer.from(JSON.stringify({ ...f.manifest, ...change }));
    await writeFile(path.join(f.directory, "manifest.json"), raw);
    await assert.rejects(
      verifyArtifact(f.root, f.parts, {
        ...f.pin,
        manifestSha256: sha256(raw),
      }),
      unavailable,
    );
  }
  await assert.rejects(verifyArtifact(f.root, [".."], f.pin), unavailable);
  await assert.rejects(verifyArtifact(f.root, ["missing"], f.pin), unavailable);
  assert.throws(
    () => installedParts({ target: "../bad", manifestSha256: "a".repeat(64) }),
    unavailable,
  );
});

test("metadata reads enforce exact byte bounds before allocating or decoding", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.directory, "bounded.json");
  await writeFile(filename, Buffer.alloc(NATIVE_POLICY.maxMetadataBytes, 32));
  assert.equal(
    (await boundedFile(filename, NATIVE_POLICY.maxMetadataBytes)).length,
    NATIVE_POLICY.maxMetadataBytes,
  );
  await writeFile(
    filename,
    Buffer.alloc(NATIVE_POLICY.maxMetadataBytes + 1, 32),
  );
  await assert.rejects(
    boundedFile(filename, NATIVE_POLICY.maxMetadataBytes),
    unavailable,
  );
});

test("linked candidate/install directories are rejected without touching their targets", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  const linked = path.join(f.root, ".native-helper");
  await symlink(
    outside,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(prepareArtifact(f.root, f.parts, f.pin), unavailable);
  assert.deepEqual(await readdir(outside), []);
  await symlink(
    f.directory,
    path.join(f.root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(verifyArtifact(f.root, ["linked"], f.pin), unavailable);
});

test("cancelled or failed preparation never publishes a partial installation", async (t) => {
  const f = await fixture(t);
  const cancellation = new AbortController();
  cancellation.abort(new Error("synthetic cancellation"));
  await assert.rejects(
    prepareArtifact(f.root, f.parts, f.pin, cancellation.signal),
    /synthetic cancellation/,
  );
  await assert.rejects(prepareArtifact(f.root, f.parts, f.pin), unavailable);
  const parent = path.join(f.root, ".native-helper", f.pin.target);
  assert.deepEqual(await readdir(parent), []);
});

test("an interrupted staging directory is never selected as a prepared helper", async (t) => {
  const f = await fixture(t);
  const stage = path.join(
    f.root,
    ".native-helper",
    f.pin.target,
    ".preparing-interrupted",
  );
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, "partial"), "fixture");
  await assert.rejects(inspectPreparedHelper(f.root, f.pin), unavailable);
  assert.equal(await readFile(path.join(stage, "partial"), "utf8"), "fixture");
});

test("default runtime lookup stays explicitly unavailable with no published pin and has no preparation side effects", async () => {
  await assert.rejects(preparedNativeHelper(), unavailable);
  await assert.rejects(preparedNativeHelper(), unavailable);
});

test(
  "real packaged helper preparation is idempotent and tampering is not repaired silently",
  { skip: !process.env.AGENT_INSIGHTS_TEST_HELPER },
  async (t) => {
    const binary = await readFile(process.env.AGENT_INSIGHTS_TEST_HELPER!);
    const f = await fixture(t, binary);
    const installed = await prepareArtifact(f.root, f.parts, f.pin);
    assert.equal(await inspectPreparedHelper(f.root, f.pin), installed);
    assert.equal(await prepareArtifact(f.root, f.parts, f.pin), installed);
    await chmod(installed, 0o700);
    await writeFile(installed, "tampered");
    await assert.rejects(inspectPreparedHelper(f.root, f.pin), unavailable);
    await assert.rejects(prepareArtifact(f.root, f.parts, f.pin), unavailable);
  },
);

test("manifest contract rejects architecture mismatch and notice tampering", async (t) => {
  const f = await fixture(t);
  const alternate =
    f.pin.target === "x86_64-unknown-linux-gnu"
      ? "aarch64-apple-darwin"
      : "x86_64-unknown-linux-gnu";
  await assert.rejects(
    verifyArtifact(f.root, f.parts, { ...f.pin, target: alternate }),
    unavailable,
  );
  assert.equal(
    nativeManifestSchema.safeParse({ ...f.manifest, target: alternate })
      .success,
    false,
  );
  await writeFile(path.join(f.directory, "THIRD-PARTY-NOTICES.txt"), "changed");
  await assert.rejects(verifyArtifact(f.root, f.parts, f.pin), unavailable);
});
