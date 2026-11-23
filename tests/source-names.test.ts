/** Presentation naming does not alter grants, paths or producer identity. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceLocation } from "../src/runtime/protocol.js";
import { sourceName } from "../src/web/source-names.js";

/** Synthetic grants retain full configured spelling, including Windows separators. */
function grant(path: string): SourceLocation {
  return { id: path, path, kind: "directory", available: true, reason: null };
}

test("duplicate basenames use the shortest distinguishing suffix on either platform", () => {
  const sources = [
    grant("/vscode/stable/User"),
    grant("/vscode/insiders/User"),
    grant("C:\\custom\\User"),
  ];
  assert.deepEqual(
    sources.map((source) => sourceName(source, sources)),
    ["stable / User", "insiders / User", "custom / User"],
  );
  assert.equal(sourceName(sources[0]!, [sources[0]!]), "User");
});

test("identical paths and filesystem roots retain configured spelling", () => {
  const same = [grant("/one/User"), grant("/one/User")];
  assert.equal(sourceName(same[0]!, same), "/one/User");
  assert.equal(sourceName(grant("/"), [grant("/")]), "/");
  assert.equal(sourceName(grant("C:\\"), [grant("C:\\")]), "C:\\");
  const nested = [grant("/one/User"), grant("/nested/one/User")];
  assert.deepEqual(
    nested.map((source) => sourceName(source, nested)),
    ["/one/User", "nested / one / User"],
  );
});
