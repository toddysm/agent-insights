/** CI-only download of a checksum-pinned test runtime; never installs or updates a user's Copilot. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

assert.equal(
  process.env.CI,
  "true",
  "This download is restricted to continuous integration.",
);
assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_ENV);
const assets = {
  "linux-x64": [
    "copilot-linux-x64.tar.gz",
    "fa9722665f2c670aa6ce26f1eb30fbfe7ed0177606bf61c21125855345c9c447",
  ],
  "darwin-arm64": [
    "copilot-darwin-arm64.tar.gz",
    "c6084c40bb761be1b1bbaff3f69426ee51d842327b6b4af0d9290436477cc708",
  ],
  "darwin-x64": [
    "copilot-darwin-x64.tar.gz",
    "fdda9b07e1f14cdbb2f506f64d679682937417bce33869d69dcde8d34f681278",
  ],
  "win32-x64": [
    "copilot-win32-x64.zip",
    "8b29500d2414d132b37ca2e158d784de479e8c6449bb7cd9b5d14d155092815a",
  ],
};
const asset = assets[`${process.platform}-${process.arch}`];
assert.ok(asset, "No qualified archive is pinned for this runner.");
const [name, digest] = asset;
const root = await mkdtemp(
  path.join(process.env.RUNNER_TEMP, "agent-insights-qualified-"),
);
const archive = path.join(root, name);
try {
  const response = await fetch(
    `https://github.com/github/copilot-cli/releases/download/v1.0.104/${name}`,
    {
      signal: AbortSignal.timeout(120_000),
    },
  );
  assert.ok(
    response.ok,
    `Copilot qualification download failed: HTTP ${response.status}.`,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    digest,
    "Copilot archive checksum mismatch.",
  );
  await writeFile(archive, bytes);
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:QUAL_ARCHIVE -DestinationPath $env:QUAL_ROOT",
      ],
      {
        env: { ...process.env, QUAL_ARCHIVE: archive, QUAL_ROOT: root },
        timeout: 60_000,
      },
    );
  } else {
    execFileSync("tar", ["-xf", archive, "-C", root], { timeout: 60_000 });
  }
  await rm(archive);
  const executable = path.join(
    root,
    process.platform === "win32" ? "copilot.exe" : "copilot",
  );
  await access(executable);
  assert.ok(!/[\r\n]/.test(executable));
  await appendFile(
    process.env.GITHUB_ENV,
    `COPILOT_QUALIFICATION_PATH=${executable}\nCOPILOT_QUALIFICATION_ROOT=${root}\n`,
  );
  console.log(
    "Prepared checksum-verified Copilot 1.0.104 for synthetic qualification.",
  );
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}
