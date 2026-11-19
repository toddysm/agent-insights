/** Exercise startup and hosted CLI preparation in owned directories without real captures or model calls. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import childProcess from "node:child_process";
import crypto, { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

/**
 * Copy application inputs and link installed dependencies, never warm build output.
 * @param {import("node:test").TestContext} t - Owns cleanup of the temporary checkout.
 * @returns {Promise<string>} Prepared directory; rejects on filesystem/setup failure.
 */
async function freshCheckout(t) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-startup-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    cp(path.join(project, "src"), path.join(directory, "src"), {
      recursive: true,
    }),
    ...["package.json", "tsconfig.json", ".npmrc"].map((file) =>
      cp(path.join(project, file), path.join(directory, file)),
    ),
  ]);
  await symlink(
    path.join(project, "node_modules"),
    path.join(directory, "node_modules"),
    "junction",
  );
  await assert.rejects(access(path.join(directory, ".build")), {
    code: "ENOENT",
  });
  return directory;
}

/**
 * Invoke npm's JavaScript entry point so Windows needs no shell command quoting.
 * @param {string} directory - Prepared checkout in which to build and request CLI help.
 * @returns {Promise<{stdout: string, stderr: string}>} Captured output; rejects on command failure or timeout.
 */
async function npmStart(directory) {
  const npm = process.env.npm_execpath;
  assert.ok(npm, "Run this suite with npm test or npm run test:startup.");
  return execute(process.execPath, [npm, "start", "--", "--help"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

test("npm start builds a clean checkout and rebuilds stale output before forwarding CLI arguments", async (t) => {
  const directory = await freshCheckout(t);
  const first = await npmStart(directory);
  assert.match(first.stdout, /--source PATH/);
  assert.doesNotMatch(first.stderr, /MODULE_NOT_FOUND/);
  await Promise.all([
    access(path.join(directory, ".build/src/runtime/cli.js")),
    access(path.join(directory, ".build/public/app.js")),
    access(path.join(directory, ".build/public/app.css")),
  ]);
  await writeFile(
    path.join(directory, ".build/src/runtime/cli.js"),
    'process.stdout.write("STALE_RUNTIME_EXECUTED");',
  );
  const next = await npmStart(directory);
  assert.match(next.stdout, /--source PATH/);
  assert.doesNotMatch(next.stdout, /STALE_RUNTIME_EXECUTED/);
});

test("a failed startup build stops before executing an existing runtime", async (t) => {
  const directory = await freshCheckout(t);
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts.build = 'node -e "process.exit(7)"';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(path.join(directory, ".build/src/runtime"), { recursive: true });
  await writeFile(
    path.join(directory, ".build/src/runtime/cli.js"),
    'process.stdout.write("STALE_RUNTIME_EXECUTED");',
  );
  await assert.rejects(npmStart(directory), (error) => {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error);
    assert.equal(error.code, 7);
    assert.ok(typeof error.stdout === "string");
    assert.doesNotMatch(error.stdout, /STALE_RUNTIME_EXECUTED/);
    return true;
  });
});

for (const fails of [false, true]) {
  test(`Windows qualification extraction ${fails ? "propagates failure and removes its owned directory" : "publishes the executable from paths with spaces and quotes"}`, async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "agent-insights-qualification-'space "),
    );
    const environmentFile = path.join(directory, "github-env");
    await writeFile(environmentFile, "");
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const arch = Object.getOwnPropertyDescriptor(process, "arch");
    const environment = { ...process.env };
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", arch);
      for (const key of ["CI", "RUNNER_TEMP", "GITHUB_ENV"]) {
        if (environment[key] === undefined) delete process.env[key];
        else process.env[key] = environment[key];
      }
      await rm(directory, { recursive: true, force: true });
    });
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "arch", { value: "x64" });
    process.env.CI = "true";
    process.env.RUNNER_TEMP = directory;
    process.env.GITHUB_ENV = environmentFile;
    const bytes = Buffer.from("synthetic archive; never executed");
    t.mock.method(globalThis, "fetch", async () => new Response(bytes));
    // Replace only the download trust boundary; extraction filesystem effects remain real.
    let verified = false;
    t.mock.method(crypto, "createHash", () => ({
      update(value) {
        assert.deepEqual(value, bytes);
        return this;
      },
      digest() {
        verified = true;
        return "8b29500d2414d132b37ca2e158d784de479e8c6449bb7cd9b5d14d155092815a";
      },
    }));
    const failure = new Error("synthetic extractor exited with status 2");
    let extractedRoot;
    t.mock.method(childProcess, "execFileSync", (command, args, options) => {
      assert.equal(verified, true);
      assert.equal(command, "tar");
      extractedRoot = path.dirname(args[1]);
      assert.deepEqual(args, [
        "-xf", path.join(extractedRoot, "copilot-win32-x64.zip"), "-C", extractedRoot,
      ]);
      assert.equal(options.shell, undefined);
      if (fails) throw failure;
      writeFileSync(path.join(extractedRoot, "copilot.exe"), "synthetic executable");
      return Buffer.alloc(0);
    });
    syncBuiltinESMExports();
    const pending = import(
      new URL(`../scripts/prepare-copilot-qualification.mjs?test=${randomUUID()}`, import.meta.url)
    );
    if (fails) {
      await assert.rejects(pending, (error) => error === failure);
      await assert.rejects(access(extractedRoot), { code: "ENOENT" });
      assert.equal(await readFile(environmentFile, "utf8"), "");
    } else {
      await pending;
      assert.equal(
        await readFile(environmentFile, "utf8"),
        `COPILOT_QUALIFICATION_PATH=${path.join(extractedRoot, "copilot.exe")}\nCOPILOT_QUALIFICATION_ROOT=${extractedRoot}\n`,
      );
      assert.deepEqual(await readdir(extractedRoot), ["copilot.exe"]);
    }
  });
}
