/** Verify artifact trust, containment and preparation using temporary owned packages; no session sources or downloads. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  NATIVE_POLICY,
  nativeManifestSchema,
  nativeTarget,
  releasedNativePin,
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
import { prepareReleasedArtifact } from "../src/native/release-preparation.js";
import {
  NATIVE_RELEASE,
  NATIVE_RELEASE_PINS,
} from "../src/runtime/native-release.js";
import { RuntimeError } from "../src/runtime/errors.js";

/** Expect a controlled failure, never an empty/success-shaped unavailable result. */
function unavailable(error: unknown): boolean {
  return (
    error instanceof RuntimeError && error.code === "NATIVE_GUARD_UNAVAILABLE"
  );
}

/** Native preparation is optional on unsupported hosts; checksum/metadata tests still run with a fixed target. */
function supportedTarget(): NativeManifest["target"] | undefined {
  try {
    return nativeTarget();
  } catch (error) {
    if (!unavailable(error)) throw error;
    return undefined;
  }
}
const host = supportedTarget();
const nativeOnly = {
  skip:
    host === undefined
      ? "No qualified native host; file-only verification tests still run."
      : false,
};

/** Inject disappearance only at the second exact executable lookup, after its full package verification. */
function failFinalLookup(t: TestContext, executable: string): void {
  const original = fsPromises.realpath;
  let seen = 0;
  const replacement = t.mock.method(
    fsPromises,
    "realpath",
    async (filename: Parameters<typeof fsPromises.realpath>[0]) => {
      if (String(filename) === executable && ++seen === 2)
        throw Object.assign(new Error("synthetic private artifact path"), {
          code: "ENOENT",
        });
      return original(filename);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    replacement.mock.restore();
    syncBuiltinESMExports();
  });
}

/** Create a bounded fictional package with an independent trust pin and automatic cleanup. */
async function fixture(
  t: TestContext,
  binary: Buffer = Buffer.from("exit 1\n"),
  selected: NativeManifest["target"] = "aarch64-apple-darwin",
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "insights-artifact-"));
  t.after(() => rm(root, { recursive: true }));
  const parts = ["candidate"];
  const directory = path.join(root, ...parts);
  await mkdir(directory);
  const name = executableName(selected);
  const notices = Buffer.from(
    "Synthetic test notices, not a released binary.\n",
  );
  const manifest: NativeManifest = {
    formatVersion: 1,
    target: selected,
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
      target: selected,
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

test(
  "linked candidate/install directories are rejected without touching their targets",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, undefined, host);
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
    await assert.rejects(
      verifyArtifact(f.root, ["linked"], f.pin),
      unavailable,
    );
  },
);

test(
  "cancelled or failed preparation never publishes a partial installation",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, undefined, host);
    const cancellation = new AbortController();
    cancellation.abort(new Error("synthetic cancellation"));
    await assert.rejects(
      prepareArtifact(f.root, f.parts, f.pin, cancellation.signal),
      /synthetic cancellation/,
    );
    await assert.rejects(prepareArtifact(f.root, f.parts, f.pin), unavailable);
    const parent = path.join(f.root, ".native-helper", f.pin.target);
    assert.deepEqual(await readdir(parent), []);
  },
);

test(
  "an interrupted staging directory is never selected as a prepared helper",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, undefined, host);
    const stage = path.join(
      f.root,
      ".native-helper",
      f.pin.target,
      ".preparing-interrupted",
    );
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(stage, "partial"), "fixture");
    await assert.rejects(inspectPreparedHelper(f.root, f.pin), unavailable);
    assert.equal(
      await readFile(path.join(stage, "partial"), "utf8"),
      "fixture",
    );
  },
);

test(
  "cancellation during staging removes only that attempt's files",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, undefined, host);
    const controller = new AbortController();
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    t.mock.method(controller.signal, "throwIfAborted", () => {
      if (++checks === 3)
        controller.abort(new Error("cancel during staged copy"));
      check();
    });
    await assert.rejects(
      prepareArtifact(f.root, f.parts, f.pin, controller.signal),
      /cancel during staged copy/,
    );
    assert.equal(checks, 3);
    assert.deepEqual(
      await readdir(path.join(f.root, ".native-helper", f.pin.target)),
      [],
    );
    assert.deepEqual(await verifyArtifact(f.root, f.parts, f.pin), f.manifest);
  },
);

test(
  "read-only installed verification has no network or executable side effects",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, undefined, host);
    const destination = path.join(f.root, ...installedParts(f.pin));
    await mkdir(destination, { recursive: true });
    for (const name of [
      "manifest.json",
      f.manifest.binary.name,
      "THIRD-PARTY-NOTICES.txt",
    ])
      await writeFile(
        path.join(destination, name),
        await readFile(path.join(f.directory, name)),
      );
    await chmod(path.join(destination, f.manifest.binary.name), 0o700);
    t.mock.method(globalThis, "fetch", () => {
      throw new Error("Network is forbidden");
    });
    const before = await readdir(destination);
    // The fake binary would fail if launched; inspection is strictly checksumming metadata/files.
    assert.equal(
      await inspectPreparedHelper(f.root, f.pin),
      path.join(await realpath(destination), f.manifest.binary.name),
    );
    assert.deepEqual(await readdir(destination), before);
  },
);

test(
  "a prepared helper that loses execute permission is explicitly unavailable",
  { skip: host === undefined || process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, undefined, host);
    const destination = path.join(f.root, ...installedParts(f.pin));
    await mkdir(destination, { recursive: true });
    for (const name of [
      "manifest.json",
      f.manifest.binary.name,
      "THIRD-PARTY-NOTICES.txt",
    ])
      await writeFile(
        path.join(destination, name),
        await readFile(path.join(f.directory, name)),
      );
    await chmod(path.join(destination, f.manifest.binary.name), 0o600);
    await assert.rejects(inspectPreparedHelper(f.root, f.pin), unavailable);
  },
);

test("default runtime lookup stays explicitly unavailable without the pinned installation and never prepares it", async () => {
  await assert.rejects(preparedNativeHelper(), unavailable);
  await assert.rejects(preparedNativeHelper(), unavailable);
});

/** Extend the owned synthetic package with independently trusted release provenance and exact metadata length. */
async function releaseFixture(t: TestContext, binary?: Buffer) {
  const f = await fixture(t, binary, host);
  f.manifest.sourceCommit = NATIVE_RELEASE.sourceCommit;
  const raw = Buffer.from(JSON.stringify(f.manifest) + "\n");
  await writeFile(path.join(f.directory, "manifest.json"), raw);
  return {
    ...f,
    pin: {
      target: f.manifest.target,
      manifestSha256: sha256(raw),
      manifestBytes: raw.length,
    },
  };
}

/** Serve only fixed release asset names from synthetic owned files; record requests without making network calls. */
async function releaseDownloads(
  t: TestContext,
  f: Awaited<ReturnType<typeof releaseFixture>>,
  replace?: (asset: string, bytes: Buffer) => Response,
) {
  const assets = new Map([
    [
      `manifest-${f.pin.target}.json`,
      await readFile(path.join(f.directory, "manifest.json")),
    ],
    [
      `agent-insights-sqlite-helper-${f.pin.target}${f.pin.target === "x86_64-pc-windows-msvc" ? ".exe" : ""}`,
      await readFile(path.join(f.directory, f.manifest.binary.name)),
    ],
    [
      `THIRD-PARTY-NOTICES-${f.pin.target}.txt`,
      await readFile(path.join(f.directory, "THIRD-PARTY-NOTICES.txt")),
    ],
  ]);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    assert.ok(url.startsWith(NATIVE_RELEASE.downloadBase));
    const asset = url.slice(NATIVE_RELEASE.downloadBase.length);
    requests.push(asset);
    const bytes = assets.get(asset);
    assert.ok(
      bytes,
      "Only the three fixed release filenames may be requested.",
    );
    return replace
      ? replace(asset, bytes)
      : new Response(Uint8Array.from(bytes), {
          headers: { "content-length": String(bytes.length) },
        });
  });
  return requests;
}

test("release policy pins exactly four targets to one qualified revision, never latest or candidate receipts", () => {
  assert.equal(NATIVE_RELEASE_PINS.length, 4);
  assert.equal(new Set(NATIVE_RELEASE_PINS.map((pin) => pin.target)).size, 4);
  assert.equal(
    NATIVE_RELEASE.sourceCommit,
    "d0cabfcb7ce78d83a061138cd70b1cbaae47b648",
  );
  assert.equal(NATIVE_RELEASE.qualificationRun, "42125840919");
  assert.ok(NATIVE_RELEASE.downloadBase.endsWith("/native-helper-v0.1.0/"));
  assert.throws(() => releasedNativePin("../candidate"), unavailable);
  for (const pin of NATIVE_RELEASE_PINS) {
    assert.equal(releasedNativePin(pin.target), pin);
    assert.match(pin.manifestSha256, /^[a-f0-9]{64}$/);
    assert.ok(
      pin.manifestBytes > 0 &&
        pin.manifestBytes <= NATIVE_POLICY.maxMetadataBytes,
    );
    assert.ok(Object.isFrozen(pin));
  }
});

test(
  "release preparation rejects invalid pins and cancellation before network or staging",
  nativeOnly,
  async (t) => {
    const f = await releaseFixture(t);
    const requests = await releaseDownloads(t, f);
    await assert.rejects(
      prepareReleasedArtifact(f.root, { ...f.pin, manifestSha256: "invalid" }),
      unavailable,
    );
    await assert.rejects(
      prepareReleasedArtifact(f.root, {
        ...f.pin,
        manifestBytes: NATIVE_POLICY.maxMetadataBytes + 1,
      }),
      unavailable,
    );
    await assert.rejects(
      prepareReleasedArtifact(f.root, { ...f.pin, manifestBytes: -1 }),
      unavailable,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      prepareReleasedArtifact(f.root, f.pin, controller.signal),
      { name: "AbortError" },
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(await readdir(f.root), ["candidate"]);
  },
);

test(
  "release preparation authenticates metadata before downloading or running an executable",
  nativeOnly,
  async (t) => {
    const f = await releaseFixture(t);
    const requests = await releaseDownloads(
      t,
      f,
      (_asset, bytes) =>
        new Response(Uint8Array.from(Buffer.alloc(bytes.length))),
    );
    await assert.rejects(prepareReleasedArtifact(f.root, f.pin), unavailable);
    assert.deepEqual(requests, [`manifest-${f.pin.target}.json`]);
    assert.deepEqual(
      await readdir(path.join(f.root, ".native-helper", f.pin.target)),
      [],
    );
  },
);

test(
  "release preparation rejects separately pinned metadata for another source revision",
  nativeOnly,
  async (t) => {
    const f = await releaseFixture(t);
    f.manifest.sourceCommit = "a".repeat(40);
    const raw = Buffer.from(JSON.stringify(f.manifest) + "\n");
    await writeFile(path.join(f.directory, "manifest.json"), raw);
    f.pin.manifestSha256 = sha256(raw);
    f.pin.manifestBytes = raw.length;
    const requests = await releaseDownloads(t, f);
    await assert.rejects(prepareReleasedArtifact(f.root, f.pin), unavailable);
    assert.equal(requests.length, 1);
  },
);

test(
  "release downloads reject failed requests and untrusted redirects without leaking diagnostics",
  nativeOnly,
  async (t) => {
    for (const status of [404, 500]) {
      const f = await releaseFixture(t);
      await releaseDownloads(
        t,
        f,
        () => new Response("unavailable", { status }),
      );
      await assert.rejects(prepareReleasedArtifact(f.root, f.pin), unavailable);
    }
    const f = await releaseFixture(t);
    const requests = await releaseDownloads(
      t,
      f,
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.invalid/private" },
        }),
    );
    await assert.rejects(prepareReleasedArtifact(f.root, f.pin), unavailable);
    assert.equal(requests.length, 1);
    t.mock.method(globalThis, "fetch", async () => {
      throw new TypeError("synthetic private transport diagnostic");
    });
    await assert.rejects(
      prepareReleasedArtifact(f.root, f.pin),
      (error: unknown) =>
        unavailable(error) &&
        error instanceof Error &&
        !error.message.includes("private"),
    );
  },
);

test(
  "release downloads bound missing-length streams and reject truncated, tampered and oversized bytes",
  nativeOnly,
  async (t) => {
    for (const adjustment of [-1, 0, 1]) {
      const f = await releaseFixture(t);
      await releaseDownloads(t, f, (asset, bytes) => {
        if (asset.startsWith("manifest-"))
          return new Response(Uint8Array.from(bytes));
        return new Response(
          Uint8Array.from(Buffer.alloc(bytes.length + adjustment)),
        );
      });
      await assert.rejects(prepareReleasedArtifact(f.root, f.pin), unavailable);
      assert.deepEqual(
        await readdir(path.join(f.root, ".native-helper", f.pin.target)),
        [],
      );
    }
    const f = await releaseFixture(t);
    await releaseDownloads(
      t,
      f,
      (_asset, bytes) =>
        new Response(Uint8Array.from(bytes), {
          headers: { "content-length": String(bytes.length + 1) },
        }),
    );
    await assert.rejects(prepareReleasedArtifact(f.root, f.pin), unavailable);
  },
);

test(
  "interrupted release body streams fail explicitly and leave no selected installation",
  nativeOnly,
  async (t) => {
    const f = await releaseFixture(t);
    await releaseDownloads(
      t,
      f,
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new TypeError("synthetic interrupted transport"),
              );
            },
          }),
        ),
    );
    await assert.rejects(prepareReleasedArtifact(f.root, f.pin), unavailable);
    assert.deepEqual(
      await readdir(path.join(f.root, ".native-helper", f.pin.target)),
      [],
    );
  },
);

test(
  "real helper release preparation checks the handshake and is offline/idempotent after installation",
  {
    skip: host === undefined || !process.env.AGENT_INSIGHTS_TEST_HELPER,
  },
  async (t) => {
    const f = await releaseFixture(
      t,
      await readFile(process.env.AGENT_INSIGHTS_TEST_HELPER!),
    );
    const requests = await releaseDownloads(t, f);
    const executable = await prepareReleasedArtifact(f.root, f.pin);
    assert.equal(requests.length, 3);
    assert.equal(await inspectPreparedHelper(f.root, f.pin), executable);
    t.mock.method(globalThis, "fetch", () => {
      throw new Error("Existing installations must not trigger downloads.");
    });
    assert.equal(await prepareReleasedArtifact(f.root, f.pin), executable);
    await chmod(executable, 0o700);
    await writeFile(executable, "tampered");
    await assert.rejects(prepareReleasedArtifact(f.root, f.pin), unavailable);
    assert.equal(requests.length, 3);
  },
);

test(
  "post-verification lookup races return only controlled unavailable errors",
  nativeOnly,
  async (t) => {
    const f = await fixture(t, undefined, host);
    const destination = path.join(
      await realpath(f.root),
      ...installedParts(f.pin),
    );
    await mkdir(destination, { recursive: true });
    for (const name of [
      "manifest.json",
      f.manifest.binary.name,
      "THIRD-PARTY-NOTICES.txt",
    ])
      await writeFile(
        path.join(destination, name),
        await readFile(path.join(f.directory, name)),
      );
    await chmod(path.join(destination, f.manifest.binary.name), 0o700);
    failFinalLookup(t, path.join(destination, f.manifest.binary.name));
    await assert.rejects(inspectPreparedHelper(f.root, f.pin), unavailable);
  },
);

test(
  "final preparation lookup rejection is normalized after atomic publication",
  { skip: host === undefined || !process.env.AGENT_INSIGHTS_TEST_HELPER },
  async (t) => {
    const binary = await readFile(process.env.AGENT_INSIGHTS_TEST_HELPER!);
    const f = await fixture(t, binary, host);
    const executable = path.join(
      await realpath(f.root),
      ...installedParts(f.pin),
      f.manifest.binary.name,
    );
    failFinalLookup(t, executable);
    await assert.rejects(prepareArtifact(f.root, f.parts, f.pin), unavailable);
  },
);

test(
  "real packaged helper preparation is idempotent and tampering is not repaired silently",
  { skip: host === undefined || !process.env.AGENT_INSIGHTS_TEST_HELPER },
  async (t) => {
    const binary = await readFile(process.env.AGENT_INSIGHTS_TEST_HELPER!);
    const f = await fixture(t, binary, host);
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
