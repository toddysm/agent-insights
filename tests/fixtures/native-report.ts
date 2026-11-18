/**
 * Independently authored Agent Host report fixtures; no captured content or model use.
 * The real combined reader qualifies projected catalog witnesses and parses native JSONL.
 * These projections test reader/report contracts, not native-helper producer compatibility.
 */
import { createHash } from "node:crypto";
import { agentHostSessionReader } from "../../src/evidence/readers/agent-host-session.js";
import type {
  MultiSourceInput,
  SqliteRow,
} from "../../src/evidence/source-access.js";
import type { ReadView } from "../../src/evidence/contracts.js";

/** Source text intentionally includes HTML, a URL and a multiline command; all must remain inert. */
export const reportCommand =
  'printf "<script>window.reportInjected=true</script>"\nprintf "https://untrusted.invalid/never-open"';

/** Fictional format-1 lifecycle with original message IDs, parallel tools and non-additive usage. */
export function nativeReportRecords(): readonly unknown[] {
  /** Emit one source envelope with explicit timestamps; relationships are not inferred by the UI. */
  const event = (
    type: string,
    id: string,
    ms: number,
    data: Record<string, unknown>,
    fields: Record<string, unknown> = {},
  ) => ({
    id,
    type,
    timestamp: new Date(1793700000000 + ms).toISOString(),
    parentId: "start",
    data,
    ...fields,
  });
  return [
    event(
      "session.start",
      "start",
      0,
      {
        sessionId: "sdk-report-fictional",
        version: 1,
        producer: "copilot-agent",
        copilotVersion: "1.0.103-unstable.r41379698026.g3219c66",
      },
      { parentId: null },
    ),
    event("user.message", "request", 100, {
      content:
        '<img src=x onerror="window.reportInjected=true">Please inspect the fictional fixture.',
      messageId: "human-request",
    }),
    event("assistant.turn_start", "turn-start", 200, { turnId: "turn" }),
    event("tool.execution_start", "shell-start", 1000, {
      toolCallId: "shell-call",
      toolName: "shell",
      arguments: { command: reportCommand, cwd: "/fictional/project" },
      turnId: "turn",
    }),
    event("tool.execution_start", "read-start", 2000, {
      toolCallId: "read-call",
      toolName: "read",
      arguments: { path: "fictional.txt" },
      turnId: "turn",
    }),
    event("tool.execution_complete", "read-end", 4000, {
      toolCallId: "read-call",
      success: true,
      result: { content: "Fictional file content" },
    }),
    event("tool.execution_complete", "shell-end", 6000, {
      toolCallId: "shell-call",
      success: true,
      result: {
        content:
          "<script>window.reportInjected=true</script>\nstdout: fictional\nstderr: none\nexit status: 0",
      },
    }),
    event("assistant.message", "response", 6500, {
      content:
        "The fictional inspection is complete; this is a source statement, not verified task completion.",
      messageId: "assistant-response",
    }),
    event("assistant.turn_end", "turn-end", 7000, { turnId: "turn" }),
    event("session.usage_info", "usage", 7100, {
      tokenLimit: 10000,
      currentTokens: 120,
      messagesLength: 2,
    }),
    event("session.shutdown", "shutdown", 7200, {
      modelMetrics: {
        "fictional-model": { usage: { inputTokens: 20, outputTokens: 10 } },
      },
    }),
  ];
}

/** Exact projection-shaped catalog rows, matching the native integration schema without filesystem identity guesses. */
export function nativeReportCatalog(): SqliteRow[] {
  const records: { table: string; key: string; values: SqliteRow["values"] }[] =
    [
      {
        table: "chats_v2",
        key: "chat_uri",
        values: {
          chat_uri: "copilotcli:/report/chat",
          owner_session_uri: "copilotcli:/report",
          storage_resource: "copilotcli:/sdk-report-fictional",
          provider_data: '{"sdkSessionId":"sdk-report-fictional"}',
          parent_chat: null,
          tombstoned: 0n,
          archived: 0n,
          origin_session_uri: null,
        },
      },
      {
        table: "sessions_v2",
        key: "session_uri",
        values: {
          session_uri: "copilotcli:/report",
          provider: "copilotcli",
          session_generation: "g1",
          verified: 1n,
          is_chat_backing: 0n,
        },
      },
      {
        table: "session_chat_catalogs",
        key: "session_uri",
        values: {
          session_uri: "copilotcli:/report",
          authority_version: 2n,
          session_generation: "g1",
          revision: 1n,
          projected_revision: 1n,
        },
      },
    ];
  return records.map(({ table, key, values }) => ({
    table,
    values,
    key: [{ column: key, type: "text", value: String(values[key]) }],
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify(values, (_key, value: unknown) =>
          typeof value === "bigint" ? String(value) : value,
        ),
      )
      .digest("hex"),
  }));
}

/** Feed actual native readers with bounded synthetic bytes/projections, including wrong-runtime and partial cases. */
export async function nativeReportView(
  options: { readId?: string; raw?: string; catalogAvailable?: boolean } = {},
): Promise<ReadView> {
  const bytes = Buffer.from(
    options.raw ??
      nativeReportRecords()
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
  );
  const input: MultiSourceInput = {
    readId: options.readId ?? "report-read",
    signal: new AbortController().signal,
    get(key) {
      if (key === "history")
        return {
          available: true,
          kind: "file",
          sourceId: "native-history",
          bytes: {
            async *[Symbol.asyncIterator]() {
              yield bytes;
            },
          },
        };
      if (key === "catalog" && options.catalogAvailable !== false)
        return {
          available: true,
          kind: "sqlite",
          sourceId: "host-catalog",
          userVersion: 22,
          snapshotScope: "connection",
          async query(query) {
            const table =
              query === "sdk_chats"
                ? "chats_v2"
                : query === "owner"
                  ? "sessions_v2"
                  : query === "authority"
                    ? "session_chat_catalogs"
                    : null;
            if (
              !table &&
              ![
                "session_backed_chats",
                "storage_identity",
                "metadata_key",
              ].includes(query)
            )
              throw new Error("Unexpected fixture catalog query");
            return nativeReportCatalog().filter((row) => row.table === table);
          },
        };
      return {
        available: false,
        sourceId: key === "catalog" ? "host-catalog" : "native-overlay",
        code: "SOURCE_MISSING",
        reason: "Synthetic optional source not selected.",
      };
    },
  };
  return agentHostSessionReader.read(input);
}
