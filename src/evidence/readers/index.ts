/** Explicit production reader registry; adding an identifier alone never installs a parser. */
import type { EvidenceReader } from "../contracts.js";
import { vscodeOtelReader } from "./vscode-otel.js";
import type { MultiSourceReader } from "../source-access.js";
import { agentHostConversationReader } from "./agent-host-conversation.js";

/** Supported format adapters installed by the executable; no dynamic capture/plugin discovery occurs. */
export const productionReaders: readonly EvidenceReader[] = Object.freeze([
  vscodeOtelReader,
]);

/** Native conversation access requires catalog and history grants, never a single-file harness guess. */
export const productionMultiSourceReaders: readonly MultiSourceReader[] = Object.freeze([
  agentHostConversationReader,
]);
