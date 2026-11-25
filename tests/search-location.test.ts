/** Immediate location-edit guidance complements, but never substitutes for, runtime containment checks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { searchLocationError } from "../src/web/search-location.js";

test("whole-folder and confined profile/file paths remain valid, including confined normalization", () => {
  for (const selection of [
    "",
    "profiles/example",
    "session/events.jsonl",
    "profiles\\example",
    "profiles/../sessions",
    "./sessions",
  ])
    for (const source of [
      "/sources",
      "C:\\sources",
      "\\\\server\\share\\sources",
    ])
      assert.equal(searchLocationError(selection, source), null, selection);
});

test("guidance follows the configured server path syntax and preserves runtime-confined literal names", () => {
  for (const [source, syntax, selections] of [
    [
      "/sources",
      path.posix,
      ["C:notes", "C:\\notes", "\\notes", "a\\..\\..\\b", "..\\notes"],
    ],
    ["C:\\sources", path.win32, ["C:notes", "a\\..\\b", "a/../b"]],
    ["\\\\server\\share\\sources", path.win32, ["a\\..\\b"]],
  ] as const) {
    for (const selection of selections) {
      const resolved = syntax.resolve(source, selection);
      const relative = syntax.relative(source, resolved);
      assert.ok(
        !syntax.isAbsolute(relative) &&
          relative !== ".." &&
          !relative.startsWith(`..${syntax.sep}`),
        selection,
      );
      assert.equal(searchLocationError(selection, source), null, selection);
    }
  }
});

test("absolute and escaping selections receive guidance in the configured path flavor", () => {
  for (const source of [
    "/sources",
    "C:\\sources",
    "\\\\server\\share\\sources",
  ]) {
    const selections = ["/outside", "../outside", "profiles/../../outside"];
    if (source !== "/sources")
      selections.push(
        "\\outside",
        "C:\\outside",
        "..\\outside",
        "a\\..\\..\\outside",
      );
    for (const selection of selections)
      assert.match(
        searchLocationError(selection, source) ?? "",
        /relative|inside/,
        selection,
      );
  }
});

test("protocol-invalid selections are rejected without truncating them or rejecting the length boundary", () => {
  assert.equal(searchLocationError("a".repeat(4096), "/sources"), null);
  assert.match(searchLocationError("a".repeat(4097), "/sources") ?? "", /4096/);
  assert.match(
    searchLocationError("profile\0name", "/sources") ?? "",
    /null characters/,
  );
});
