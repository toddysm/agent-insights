/** Isolate Cargo configuration discovery while retaining explicitly selected installed toolchain executables. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Run one required native test only after listing its exact name in the same isolated context.
 * A missing, cfg-disabled, ignored or failing test must not certify package/installation qualification.
 * @param {object} context - Isolated Cargo executable, argument policy and working directory.
 * @param {string[]} args - Code-owned Cargo test arguments selecting the test binary, without a name filter.
 * @param {string} testName - Exact code-owned Rust test name.
 * @param {NodeJS.ProcessEnv} env - The same sanitized environment for listing and execution.
 */
export function qualifyNativeTest(context, args, testName, env = context.env) {
  const testArgs = context.args([...args, testName, "--", "--exact"]);
  const options = {
    cwd: context.cwd,
    env,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  };
  const listed = execFileSync(context.cargo, [...testArgs, "--list"], options);
  assert.ok(
    listed.split(/\r?\n/).includes(`${testName}: test`),
    `Required native test is missing: ${testName}`,
  );
  const output = execFileSync(context.cargo, testArgs, options);
  assert.match(
    output,
    /^test result: ok\. 1 passed; 0 failed; 0 ignored;/m,
    `Required native test did not execute successfully: ${testName}`,
  );
  process.stdout.write(output);
}

/** Create a dedicated Cargo home/cwd; only the repository's recorded config is admitted.
 * The returned cleanup removes only the directory created by this call, after all builds/notices are complete.
 */
export async function nativeBuildContext(root, targetDirectory) {
  const toolchain = "1.91.0";
  const commands = {};
  for (const name of ["cargo", "rustc", "rustdoc"])
    commands[name] = execFileSync(
      "rustup",
      ["which", "--toolchain", toolchain, name],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4096,
      },
    ).trim();
  const cwd = await realpath(
    await mkdtemp(path.join(tmpdir(), "insights-cargo-")),
  );
  try {
    // Cargo walks cwd ancestors even with --manifest-path; reject unexpected configs outside the isolated home.
    for (let directory = cwd; ; directory = path.dirname(directory)) {
      for (const name of ["config", "config.toml"]) {
        try {
          await lstat(path.join(directory, ".cargo", name));
          throw new Error(
            "Ambient Cargo ancestor configuration prevents an isolated build.",
          );
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTDIR"].includes(String(error.code))
          ))
            throw error;
        }
      }
      if (directory === path.dirname(directory)) break;
    }
    const home = path.join(cwd, "home");
    const cargoHome = path.join(cwd, "cargo-home");
    await mkdir(home);
    await mkdir(cargoHome);
    const env = {};
    for (const name of [
      "PATH",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "TMPDIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "INCLUDE",
      "LIB",
      "LIBPATH",
      "VCINSTALLDIR",
      "VCToolsInstallDir",
      "WindowsSdkDir",
      "WindowsSDKVersion",
    ])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CARGO_HOME: cargoHome,
      CARGO_TARGET_DIR: targetDirectory,
      CARGO_INCREMENTAL: "0",
      RUSTC: commands.rustc,
      RUSTDOC: commands.rustdoc,
    });
    const config = await realpath(path.join(root, ".cargo", "config.toml"));
    assert.ok(
      path.isAbsolute(commands.rustc) && path.isAbsolute(commands.cargo),
    );
    return {
      cwd,
      env,
      ...commands,
      /** Apply the single hashed repository policy explicitly, independent of manifest-path/cwd inference. */
      args: (args) => ["--config", config, ...args],
      /** Dispose of only this invocation's isolated compiler/dependency state. */
      cleanup: () => rm(cwd, { recursive: true }),
    };
  } catch (error) {
    await rm(cwd, { recursive: true });
    throw error;
  }
}
