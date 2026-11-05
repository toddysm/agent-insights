/** Test-only selection of an independently qualified candidate. Production runtime never reads this environment override. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  inspectPreparedHelper,
  nativeTarget,
} from "../../src/runtime/native-helper.js";

/** Reverify fixed installed candidate bytes on every resolution; the harness supplies only an owned qualification root. */
export async function testNativeHelper(): Promise<string> {
  const root = process.env.AGENT_INSIGHTS_TEST_NATIVE_ROOT;
  if (!root)
    throw new Error(
      "Native integration tests require an explicitly qualified artifact root",
    );
  const selected = nativeTarget();
  const pin = z
    .object({
      target: z.literal(selected),
      manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(
      JSON.parse(
        await readFile(
          path.join(root, ".build", "native-trust", `${selected}.json`),
          "utf8",
        ),
      ),
    );
  return inspectPreparedHelper(root, pin);
}
