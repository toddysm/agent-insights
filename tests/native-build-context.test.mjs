/** Native-only regression: ambient Cargo config/flags cannot affect a candidate build or remove qualification tests. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeBuildContext } from "../scripts/native-build-context.mjs";

test("isolated Cargo ignores caller flags, wrappers and config files", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "insights-build-context-test-"),
  );
  t.after(() => rm(root, { recursive: true }));
  await mkdir(path.join(root, ".cargo"));
  await writeFile(
    path.join(root, ".cargo", "config.toml"),
    '[env]\nINSIGHTS_RECORDED_CONFIG = { value = "yes", force = true }\n',
  );
  const ambient = path.join(root, "ambient");
  await mkdir(ambient);
  await writeFile(
    path.join(ambient, "config.toml"),
    '[build]\nrustc-wrapper = "this-wrapper-must-not-run"\nrustflags = ["--cfg", \'feature="qualification-hooks"\']\n[env]\nCC = "invalid-compiler"\n',
  );
  const original = Object.fromEntries(
    ["CARGO_HOME", "RUSTFLAGS", "RUSTC_WRAPPER"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  Object.assign(process.env, {
    CARGO_HOME: ambient,
    RUSTFLAGS: '--cfg feature="qualification-hooks"',
    RUSTC_WRAPPER: "missing-wrapper",
  });
  let context;
  try {
    context = await nativeBuildContext(root, path.join(root, "target"));
  } finally {
    for (const [key, value] of Object.entries(original))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  t.after(() => context.cleanup());
  assert.notEqual(context.env.CARGO_HOME, ambient);
  assert.equal(context.env.RUSTFLAGS, undefined);
  assert.equal(context.env.RUSTC_WRAPPER, undefined);
  assert.equal(context.env.CC, undefined);
  const fixture = path.join(root, "fixture");
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await writeFile(
    path.join(fixture, "Cargo.toml"),
    '[package]\nname="isolated-build-test"\nversion="0.0.0"\nedition="2024"\n[features]\nqualification-hooks=[]\n',
  );
  await writeFile(
    path.join(fixture, "src", "lib.rs"),
    '#[cfg(feature = "qualification-hooks")]\ncompile_error!("ambient flags reached fixture");\n#[test]\nfn parent_loss_test_is_present() { assert_eq!(env!("INSIGHTS_RECORDED_CONFIG"), "yes"); }\n',
  );
  const args = context.args([
    "test",
    "--offline",
    "--manifest-path",
    path.join(fixture, "Cargo.toml"),
  ]);
  const output = execFileSync(context.cargo, args, {
    env: context.env,
    cwd: context.cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.match(output, /parent_loss_test_is_present \.\.\. ok/);
  assert.match(output, /1 passed; 0 failed/);
});
