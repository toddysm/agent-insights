/** Explicit production reader registry; adding an identifier alone never installs a parser. */
import type { EvidenceReader } from "../contracts.js";
import { vscodeOtelReader } from "./vscode-otel.js";
import type { MultiSourceReader } from "../source-access.js";
import { agentHostExecutionReader } from "./agent-host-execution.js";
import { agentHostSessionReader, agentHostUnavailableReason } from "./agent-host-session.js";

/** Supported format adapters installed by the executable; no dynamic capture/plugin discovery occurs. */
export const productionReaders: readonly EvidenceReader[] = Object.freeze([
  vscodeOtelReader,
]);

/**
 * Register executions with an explicit unavailable reason; conversations remain unregistered.
 * Both need a separately qualified release with guarded JSON/literal-prefix predicates.
 * Preparing a development candidate cannot change production availability.
 */
export const productionMultiSourceReaders: readonly MultiSourceReader[] = Object.freeze([
  Object.freeze({
    ...agentHostExecutionReader,
    unavailableReason: "Copilot Agent Host execution reading requires a separately qualified native helper release with guarded JSON and literal-prefix predicates; the pinned native-helper-v0.1.0 is incompatible.",
  }),
  Object.freeze({
    ...agentHostSessionReader,
    unavailableReason: agentHostUnavailableReason,
  }),
]);
