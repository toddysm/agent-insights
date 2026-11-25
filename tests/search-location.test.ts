/** Immediate location-edit guidance complements, but never substitutes for, runtime containment checks. */
import assert from "node:assert/strict";
import { test } from "node:test";
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
    assert.equal(searchLocationError(selection), null, selection);
});

test("absolute and escaping selections get actionable guidance on either platform", () => {
  for (const selection of [
    "/outside",
    "\\outside",
    "C:\\outside",
    "C:outside",
    "../outside",
    "profiles/../../outside",
    "..\\outside",
  ])
    assert.match(
      searchLocationError(selection) ?? "",
      /relative|inside/,
      selection,
    );
});

test("protocol-invalid selections are rejected without truncating them or rejecting the length boundary", () => {
  assert.equal(searchLocationError("a".repeat(4096)), null);
  assert.match(searchLocationError("a".repeat(4097)) ?? "", /4096/);
  assert.match(searchLocationError("profile\0name") ?? "", /null characters/);
});
