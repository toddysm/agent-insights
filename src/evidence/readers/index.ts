/** Explicit production reader registry; adding an identifier alone never installs a parser. */
import type { EvidenceReader } from "../contracts.js";
import { vscodeOtelReader } from "./vscode-otel.js";

/** Supported format adapters installed by the executable; no dynamic capture/plugin discovery occurs. */
export const productionReaders: readonly EvidenceReader[] = Object.freeze([
  vscodeOtelReader,
]);
