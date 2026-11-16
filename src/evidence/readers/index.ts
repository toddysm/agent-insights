/** Explicit production reader registry; adding an identifier alone never installs a parser. */
import type { EvidenceReader } from "../contracts.js";
import { vscodeOtelReader } from "./vscode-otel.js";
import type { MultiSourceReader } from "../source-access.js";

/** Supported format adapters installed by the executable; no dynamic capture/plugin discovery occurs. */
export const productionReaders: readonly EvidenceReader[] = Object.freeze([
  vscodeOtelReader,
]);

/**
 * Agent Host conversations remain gated until a separately qualified release pin supports
 * guarded JSON and literal-prefix predicates. Preparing a development candidate cannot enable them.
 */
export const productionMultiSourceReaders: readonly MultiSourceReader[] = Object.freeze([]);
