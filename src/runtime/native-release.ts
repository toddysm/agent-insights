/** Immutable release provenance and trust pins; importing this data performs no download or preparation. */
import type { NativeManifest, NativePin } from "./native-helper.js";

/** Independently reviewed metadata digest and exact download length for one qualified release target. */
export interface NativeReleasePin extends NativePin {
  readonly target: NativeManifest["target"];
  readonly manifestBytes: number;
}

export const NATIVE_RELEASE = Object.freeze({
  tag: "native-helper-v0.1.0",
  sourceCommit: "d0cabfcb7ce78d83a061138cd70b1cbaae47b648",
  qualificationRun: "42125840919",
  downloadBase:
    "https://github.com/toddysm/agent-insights/releases/download/native-helper-v0.1.0/",
});

export const NATIVE_RELEASE_PINS: readonly NativeReleasePin[] = Object.freeze([
  Object.freeze({
    target: "aarch64-apple-darwin",
    manifestSha256:
      "029771e3c67363a8b3cfbe34b6f6277abce700c6ec9ab5c03b041a973b2ea665",
    manifestBytes: 1691,
  }),
  Object.freeze({
    target: "x86_64-apple-darwin",
    manifestSha256:
      "6d5b2f92adf4de1c76fbeaafbe190af8025a65fadf19992391418adce1ea3b9e",
    manifestBytes: 1688,
  }),
  Object.freeze({
    target: "x86_64-unknown-linux-gnu",
    manifestSha256:
      "c45b1a287fdb8759e0bf19b7c111e0cfc990ba96e5de85ee05e8b66cfbd35911",
    manifestBytes: 1703,
  }),
  Object.freeze({
    target: "x86_64-pc-windows-msvc",
    manifestSha256:
      "2f8ef82bbe7c2adab8e52d76316300ae3418ecfd70ad158936ad5a2335bbc1fb",
    manifestBytes: 1701,
  }),
]);
