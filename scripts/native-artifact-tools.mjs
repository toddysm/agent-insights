/** Build-only provenance, fixed paths and license collection for native release candidates; never imported by the application. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  sha256,
  NATIVE_POLICY,
  boundedFile,
  containedPath,
  nativeTarget,
} from "../.build/src/runtime/native-helper.js";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const CRATE = "native/sqlite-guard/Cargo.toml";
const INPUTS = [
  "native/sqlite-guard",
  ".cargo/config.toml",
  "rust-toolchain.toml",
  "src/native",
  "src/runtime/native-helper.ts",
  "scripts/native-artifact-tools.mjs",
  "scripts/native-build-context.mjs",
  "tests/native-build-context.test.mjs",
  "scripts/package-native-helper.mjs",
  "scripts/prepare-native-helper.mjs",
  "scripts/qualify-native-helper.mjs",
  "package.json",
  "package-lock.json",
  "tests/native-artifacts.test.ts",
];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.strictObject({
  formatVersion: z.literal(1),
  target: z.string(),
  manifestSha256: digest,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceTree: digest,
  cargoLockSha256: digest,
  buildPolicySha256: digest,
  toolchainSha256: digest,
  candidate: digest,
  qualification: z.strictObject({
    passed: z.literal(true),
    processSuite: z.literal("protocol.mjs"),
    parentLoss: z.literal(true),
    nodeVersion: z.string(),
    platform: z.string(),
    architecture: z.string(),
    osRelease: z.string(),
    runner: z.string(),
    runnerArch: z.string(),
    workflowRun: z.string().nullable(),
    testedAt: z.string().datetime(),
  }),
});

/** Execute an explicit development tool with bounded output, no shell and no source-dependent arguments. */
export function tool(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  }).trim();
}

/** Compute current build-input bytes, retaining filenames/order; dirty tracked or untracked source blocks packaging. */
export async function sourceIdentity() {
  assert.equal(
    tool("git", ["status", "--porcelain", "--untracked-files=normal"]),
    "",
    "Commit source changes before building a trusted candidate.",
  );
  const names = tool("git", ["ls-files", "-z", "--", ...INPUTS])
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.ok(
    names.includes(CRATE) && names.includes("native/sqlite-guard/Cargo.lock"),
  );
  const records = [];
  for (const name of names)
    records.push([name, sha256(await readFile(path.join(ROOT, name)))]);
  return {
    sourceCommit: tool("git", ["rev-parse", "HEAD"]),
    sourceTree: sha256(JSON.stringify(records)),
    cargoLockSha256: sha256(
      await readFile(path.join(ROOT, "native/sqlite-guard/Cargo.lock")),
    ),
    buildPolicySha256: sha256(
      await readFile(path.join(ROOT, ".cargo/config.toml")),
    ),
    toolchainSha256: sha256(
      await readFile(path.join(ROOT, "rust-toolchain.toml")),
    ),
  };
}

/** Bind a candidate directory to both the source revision and its exact build inputs. */
export function candidateKey(identity) {
  return sha256(JSON.stringify(identity));
}

/** Load only the separately stored local-build receipt, matching all source identity fields before preparation/testing. */
export async function candidateReceipt() {
  const selected = nativeTarget();
  const receipt = receiptSchema.parse(
    JSON.parse(
      (
        await boundedFile(
          await containedPath(ROOT, [
            ".build",
            "native-trust",
            `${selected}.json`,
          ]),
          NATIVE_POLICY.maxMetadataBytes,
        )
      ).toString("utf8"),
    ),
  );
  const identity = await sourceIdentity();
  for (const [key, value] of Object.entries(identity))
    assert.equal(
      receipt[key],
      value,
      "Candidate no longer matches this clean source checkout",
    );
  assert.equal(receipt.target, selected);
  assert.equal(receipt.candidate, candidateKey(identity));
  assert.equal(receipt.qualification.platform, process.platform);
  assert.equal(receipt.qualification.architecture, process.arch);
  return receipt;
}

/** Run a native qualification command to completion; any failure prevents creating a trusted receipt. */
export function qualification(command, args, env = process.env, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    timeout: 600_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "Qualification process was terminated");
  assert.equal(
    result.status,
    0,
    "Qualification failed; candidate is not trusted",
  );
}

/** Collect actual license/notice texts for normal/build dependencies reachable from the native crate.
 * Native engine source remains in Cargo's checksum-pinned dependency, not copied into this repository.
 */
export async function dependencyNotices(metadata) {
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(
    metadata.resolve.nodes.map((entry) => [entry.id, entry]),
  );
  const reachable = new Set();
  /** Follow normal/build dependencies only; test-only libraries are not shipped with the helper. */
  const visit = (id) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const dep of nodes.get(id)?.deps ?? [])
      if (dep.dep_kinds.some(({ kind }) => kind !== "dev")) visit(dep.pkg);
  };
  visit(metadata.resolve.root);
  const records = [];
  for (const id of [...reachable].sort()) {
    const pkg = packages.get(id);
    assert.ok(pkg);
    const directory = path.dirname(pkg.manifest_path);
    const names = (await readdir(directory))
      .filter((name) => /^(LICENSE|COPYING|NOTICE)([-._].*)?$/i.test(name))
      .sort();
    if (!pkg.source) {
      records.push(
        `Agent Insights\n${await readFile(path.join(ROOT, "LICENSE"), "utf8")}`,
      );
      continue;
    }
    assert.ok(names.length, `No license files found for ${pkg.name}`);
    const texts = [];
    for (const name of names) {
      const filename = await realpath(path.join(directory, name));
      assert.equal(
        path.dirname(filename),
        await realpath(directory),
        "License text escaped its dependency directory",
      );
      texts.push(`${name}\n${await readFile(filename, "utf8")}`);
    }
    records.push(
      `${pkg.name} ${pkg.version}\nDeclared license: ${pkg.license}\n${texts.join("\n\n")}`,
    );
  }
  records.push(
    "SQLite is in the public domain: https://sqlite.org/copyright.html",
  );
  const result =
    records.join("\n\n----------------------------------------\n\n") + "\n";
  assert.ok(Buffer.byteLength(result) <= NATIVE_POLICY.maxNoticesBytes);
  return result;
}
