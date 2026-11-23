/**
 * Guided source discovery over explicit startup grants. No installation inference,
 * permission changes, startup scan, storage or model call occurs in this wizard.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { z } from "zod";
import type { ReadView } from "../evidence/contracts.js";
import {
  discoveryResultSchema,
  type DiscoveryRequest,
  type DiscoveryResult,
  type ReadRequest,
  type ReadSetRequest,
  type RuntimeStatus,
} from "../runtime/protocol.js";
import { SourceChoice } from "./source-choice.js";
import { sourceName } from "./source-names.js";

/** Parent owns authenticated transport, report handoff, operation locks and read feedback; callbacks do not grant source access. */
interface DiscoveryProps {
  readonly status: RuntimeStatus;
  readonly disabled: boolean;
  readonly feedback: ReactElement | null;
  readonly send: <T>(
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ) => Promise<T>;
  readonly onStart: (resetScan: boolean) => void;
  readonly onBusy: (busy: boolean) => void;
  readonly onRead: (selection: ReadSetRequest) => Promise<ReadView | null>;
  /** Refresh status and read summary without opening a report; rejects read/status failures. */
  readonly onReadFile: (selection: ReadRequest) => Promise<ReadView | null>;
  readonly onOpenFile: (view: ReadView, sessionId: string) => void;
  readonly onFileTools: (selection: ReadRequest) => void;
}

/** Stable entry identity is separate from its source ID, role and current position in the wizard. */
interface SearchEntry {
  readonly id: number;
  readonly sourceId: string;
  readonly relativePath: string;
  readonly layout: DiscoveryRequest["roots"][number]["layout"];
}

/** Branch stages are UI state, never producer identity or proof that a capture is supported. */
type Step =
  | "assistant"
  | "session"
  | "unsupported"
  | "unsure"
  | "folder"
  | "purpose"
  | "access"
  | "find"
  | "sessions"
  | "local"
  | "file"
  | "privacy"
  | "recording"
  | "recorded"
  | "file-sessions";
/** Settings homes and exact catalogs share one user-facing purpose, while requests preserve their layouts. */
type Purpose = "settings" | "history" | "overlay";

const purposeCopy: Record<Purpose, { title: string; description: string }> = {
  settings: {
    title: "VS Code session information",
    description:
      "Identifies the Agent Host sessions belonging to your VS Code setup.",
  },
  history: {
    title: "Copilot saved session history",
    description: "Provides retained messages and recorded activity.",
  },
  overlay: {
    title: "VS Code saved session details",
    description: "Adds the available session details recorded by VS Code.",
  },
};

/** Catalog and settings selections serve the same user purpose; only explicit exact-file choice changes the request role. */
function purpose(entry: SearchEntry): Purpose {
  return entry.layout === "catalog" ? "settings" : entry.layout;
}

/** Native radio choices select without advancing; their descriptions are consistent and keyboard accessible. */
function Choices<T extends string>({
  label,
  choices,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly choices: readonly {
    id: T;
    title: string;
    description: string;
    unavailable?: boolean;
  }[];
  readonly value: T | "";
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <fieldset className="wizard-choices" aria-label={label}>
      {choices.map((choice) => (
        <label className="wizard-card" key={choice.id}>
          <input
            type="radio"
            name={label}
            value={choice.id}
            checked={value === choice.id}
            disabled={disabled || choice.unavailable === true}
            onChange={() => onChange(choice.id)}
          />
          <span>
            <strong>{choice.title}</strong>
            <small>{choice.description}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Own only transient wizard selections and discovery results; parent report state is invalidated on upstream changes. */
export function SourceDiscoveryPanel({
  status,
  disabled,
  feedback,
  send,
  onStart,
  onBusy,
  onRead,
  onReadFile,
  onOpenFile,
  onFileTools,
}: DiscoveryProps): ReactElement {
  const [step, setStep] = useState<Step>("assistant");
  const [assistant, setAssistant] = useState("");
  const [sessionType, setSessionType] = useState("");
  const [entries, setEntries] = useState<readonly SearchEntry[]>([
    {
      id: 1,
      sourceId: status.sources[0]?.id ?? "",
      relativePath: "",
      layout: status.sources[0]?.kind === "file" ? "catalog" : "settings",
    },
  ]);
  const [editing, setEditing] = useState(1);
  const [returnToAccess, setReturnToAccess] = useState(false);
  const [additionalPurpose, setAdditionalPurpose] = useState<Purpose | "">("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [localChoice, setLocalChoice] = useState("");
  const [file, setFile] = useState<ReadRequest>({
    sourceId: status.sources[0]?.id ?? "",
    relativePath: "",
    format: "vscode-otel-jsonl",
  });
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [fileView, setFileView] = useState<ReadView | null>(null);
  const [selectedSession, setSelectedSession] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(1);
  const generation = useRef(0);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  const entry = entries.find((item) => item.id === editing);
  const reader = status.multiSourceReaders.find(
    (item) => item.id === "agent-host-sessions",
  );
  const ready = reader?.available === true;
  const selectedFile = status.sources.find(
    (source) => source.id === file.sourceId,
  );
  const unavailable = entries.some(
    (item) =>
      !status.sources.find((source) => source.id === item.sourceId)?.available,
  );
  const stage =
    step === "assistant" || (step === "unsupported" && assistant !== "Copilot")
      ? 0
      : ["session", "unsupported", "unsure"].includes(step)
        ? 1
        : ["sessions", "file-sessions"].includes(step)
          ? 3
          : 2;

  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    body.current?.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  /** Edits clear wizard evidence without discarding independent scans; only actual source submissions reset scans. */
  function invalidate(resetAccess = true, resetScan = false): void {
    generation.current++;
    setResult(null);
    setFileView(null);
    setSelectedSession("");
    setError("");
    if (resetAccess) setAcknowledged(false);
    onStart(resetScan);
  }

  /** Edit one stable entry without renumbering or replacing the remaining entries. */
  function updateEntry(patch: Partial<Omit<SearchEntry, "id">>): void {
    invalidate();
    setEntries((previous) =>
      previous.map((item) =>
        item.id === editing ? { ...item, ...patch } : item,
      ),
    );
  }

  /** Restart only wizard selections; grants, availability and the source safety boundary remain owned by the runtime. */
  function restart(): void {
    resetSetup();
    setAssistant("");
    setSessionType("");
    setStep("assistant");
  }

  /** Upstream changes clear dependent setup; Back alone retains the current answers. */
  function resetSetup(): void {
    invalidate();
    setLocalChoice("");
    setAdditionalPurpose("");
    setReturnToAccess(false);
    setEntries([
      {
        id: ++sequence.current,
        sourceId: status.sources[0]?.id ?? "",
        relativePath: "",
        layout: status.sources[0]?.kind === "file" ? "catalog" : "settings",
      },
    ]);
    setEditing(sequence.current);
    setFile({
      sourceId: status.sources[0]?.id ?? "",
      relativePath: "",
      format: "vscode-otel-jsonl",
    });
  }

  /** Search only on explicit submission. Transport/backend errors remain visible and never restore earlier sessions. */
  async function discover(): Promise<void> {
    invalidate(false, true);
    const current = generation.current;
    onBusy(true);
    try {
      const next = await send("/api/discover", discoveryResultSchema, {
        roots: entries.map(({ sourceId, relativePath, layout }) => ({
          sourceId,
          relativePath,
          layout,
        })),
      });
      if (current === generation.current) {
        setResult(next);
        setStep("sessions");
      }
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Saved sessions could not be found.",
        );
    } finally {
      onBusy(false);
    }
  }

  /** Read the trimmed explicit filename and refresh status/coverage feedback; opening a report and large-file tools remain separate actions. */
  async function readFile(): Promise<void> {
    invalidate(false, true);
    const current = generation.current;
    onBusy(true);
    try {
      const selection = { ...file, relativePath: file.relativePath.trim() };
      setFile(selection);
      const next = await onReadFile(selection);
      if (next && current === generation.current) {
        setFileView(next);
        setStep("file-sessions");
      }
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "The recorded file could not be read.",
        );
    } finally {
      onBusy(false);
    }
  }

  /** Open only the exact retained selection returned by discovery, or a session from the current Local read. */
  async function openSession(): Promise<void> {
    if (step === "file-sessions") {
      if (fileView?.sessions.some((session) => session.id === selectedSession))
        onOpenFile(fileView, selectedSession);
      else setError("Choose a session from the current recording.");
      return;
    }
    const selection = result?.sessions.find(
      (session) => session.id === selectedSession,
    )?.selection;
    if (!selection) {
      setError("This retained session is not available to open.");
      return;
    }
    const next = await onRead(selection);
    if (!next)
      setError(
        "The retained session could not be opened. See the read error for recovery.",
      );
  }

  /** Go back without hiding errors or restoring stale results; adding/editing entries is always a setup step. */
  function back(): void {
    setError("");
    const previous: Partial<Record<Step, Step>> = {
      session: "assistant",
      folder: returnToAccess ? "access" : "session",
      purpose: "access",
      access: "folder",
      find: "access",
      sessions: "find",
      local: "session",
      file: "local",
      privacy: "local",
      recording: "privacy",
      recorded: "recording",
      "file-sessions": "file",
      unsure: "session",
    };
    if (step === "assistant") return;
    if (step === "sessions" || step === "file-sessions") invalidate(false);
    if (step === "access") {
      setEditing(entries[0]?.id ?? editing);
      setReturnToAccess(false);
    }
    setStep(
      step === "unsupported"
        ? assistant === "Copilot"
          ? "session"
          : "assistant"
        : (previous[step] ?? "assistant"),
    );
  }

  /** Confirm a decision separately from selecting it; source reads occur only at the named Find/Open boundaries. */
  async function advance(): Promise<void> {
    if (disabled) return;
    switch (step) {
      case "assistant":
        setStep(assistant === "Copilot" ? "session" : "unsupported");
        break;
      case "session":
        setStep(
          sessionType === "Agent Host"
            ? "folder"
            : sessionType === "Local"
              ? "local"
              : sessionType === "Not sure"
                ? "unsure"
                : "unsupported",
        );
        break;
      case "folder":
        setStep("access");
        break;
      case "purpose":
        if (additionalPurpose) {
          const id = ++sequence.current;
          invalidate();
          setEntries((previous) => [
            ...previous,
            {
              id,
              sourceId: status.sources[0]?.id ?? "",
              relativePath: "",
              layout:
                additionalPurpose === "settings" &&
                status.sources[0]?.kind === "file"
                  ? "catalog"
                  : additionalPurpose,
            },
          ]);
          setEditing(id);
          setAdditionalPurpose("");
          setReturnToAccess(true);
          setStep("folder");
        }
        break;
      case "access":
        setStep("find");
        break;
      case "find":
        await discover();
        break;
      case "sessions":
      case "file-sessions":
        await openSession();
        break;
      case "local":
        setStep(localChoice === "file" ? "file" : "privacy");
        break;
      case "file":
        await readFile();
        break;
      case "privacy":
        setStep("recording");
        break;
      case "recording":
        setStep("recorded");
        break;
      case "recorded":
        setLocalChoice("file");
        setStep("file");
        break;
      case "unsupported":
      case "unsure":
        break;
    }
  }

  const noSources = status.sources.length === 0;
  const nextDisabled =
    disabled ||
    (step === "assistant" && !assistant) ||
    (step === "session" && !sessionType) ||
    (step === "folder" &&
      (noSources ||
        !entry ||
        !status.sources.find((source) => source.id === entry.sourceId)
          ?.available)) ||
    (step === "purpose" && !additionalPurpose) ||
    (step === "access" && (!acknowledged || unavailable)) ||
    (step === "find" && (!ready || unavailable || !acknowledged)) ||
    (step === "sessions" &&
      !result?.sessions.find((session) => session.id === selectedSession)
        ?.selection) ||
    (step === "local" && !localChoice) ||
    (step === "file" &&
      (!selectedFile?.available ||
        (selectedFile.kind === "directory" && !file.relativePath.trim()) ||
        !status.readers.includes("vscode-otel-jsonl"))) ||
    (step === "privacy" && !acknowledged) ||
    (step === "file-sessions" &&
      !fileView?.sessions.some((session) => session.id === selectedSession));
  const title: Record<Step, string> = {
    assistant: "Which coding assistant did you use?",
    session: "Which Copilot session option did you use?",
    unsupported: "Not supported",
    unsure: "Let's identify your session option",
    folder: entry
      ? `Choose ${purposeCopy[purpose(entry)].title.toLowerCase()}`
      : "Choose a session folder",
    purpose: "Which saved session files are you adding?",
    access: "Review access to your saved sessions",
    find: "Find your Agent Host sessions",
    sessions: "Choose an Agent Host session",
    local: "Do you have a recorded session file?",
    file: "Find sessions in your recorded file",
    privacy: "Before recording future sessions",
    recording: "Enable Local session recording",
    recorded: "Return with your recorded file",
    "file-sessions": "Choose a recorded session",
  };
  const nextLabel =
    step === "find" || step === "file"
      ? "Find sessions"
      : step === "sessions" || step === "file-sessions"
        ? "Open report"
        : step === "access"
          ? "Continue"
          : step === "recorded"
            ? "Back to file choice"
            : "Next";

  return (
    <section
      id="session-wizard"
      className="source-wizard"
      aria-labelledby="wizard-heading"
    >
      <div className="wizard-header">
        <div className="wizard-heading">
          <h2 id="wizard-heading">Find your sessions</h2>
          <button type="button" disabled={disabled} onClick={restart}>
            Start over
          </button>
        </div>
        <ol className="wizard-progress" aria-label="Wizard stages">
          {["Assistant", "Session type", "Setup", "Sessions"].map(
            (label, index) => (
              <li
                key={label}
                className={index < stage ? "done" : ""}
                aria-current={stage === index ? "step" : undefined}
              >
                {label}
              </li>
            ),
          )}
        </ol>
      </div>
      <div
        ref={body}
        className="wizard-body"
        role="region"
        aria-labelledby="wizard-question"
        tabIndex={0}
      >
        <p className="wizard-context">
          {[assistant, sessionType].filter(Boolean).join(" / ") ||
            "A few steps to the session you want to understand"}
        </p>
        <h3 ref={heading} id="wizard-question" tabIndex={-1}>
          {title[step]}
        </h3>
        {feedback}
        {error && !feedback && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {step === "assistant" && (
          <Choices
            label="Coding assistant"
            value={assistant}
            disabled={disabled}
            onChange={(value) => {
              resetSetup();
              setAssistant(value);
              setSessionType("");
            }}
            choices={[
              {
                id: "Copilot",
                title: "Copilot",
                description: "Choose your Copilot session option next.",
              },
              {
                id: "Claude Code",
                title: "Claude Code",
                description: "Not supported by Agent Insights.",
              },
              {
                id: "Codex",
                title: "Codex",
                description: "Not supported by Agent Insights.",
              },
            ]}
          />
        )}
        {step === "session" && (
          <Choices
            label="Copilot session option"
            value={sessionType}
            disabled={disabled}
            onChange={(value) => {
              resetSetup();
              setSessionType(value);
            }}
            choices={[
              {
                id: "Local",
                title: "Local",
                description:
                  "Use a recorded session file, or set up recording.",
              },
              {
                id: "Agent Host",
                title: "Agent Host",
                description: "Find sessions already saved by VS Code.",
              },
              {
                id: "Cloud Hosted",
                title: "Cloud Hosted",
                description: "Not supported by Agent Insights.",
              },
              {
                id: "Not sure",
                title: "I'm not sure",
                description: "Help me identify the session option.",
              },
            ]}
          />
        )}
        {step === "unsupported" && (
          <p role="status">
            {assistant === "Copilot" ? sessionType : assistant} sessions are not
            supported by Agent Insights. No substitute source is used.
          </p>
        )}
        {step === "unsure" && (
          <p>
            Check the option used to start the session in VS Code. Labels vary
            by version; running on your computer does not distinguish Local from
            Agent Host. Return when you have identified the option. Do not
            switch session types to work around missing evidence.
          </p>
        )}
        {(step === "folder" || step === "file") && noSources && (
          <div role="status">
            <h4>No files or folders configured</h4>
            <p>
              Restart Agent Insights with the specific session file or folder
              you want it to access:
            </p>
            <code>npm start -- --source /path/to/session-data</code>
            <p>The browser cannot grant access to another folder.</p>
          </div>
        )}
        {step === "purpose" && (
          <Choices
            label="Saved session files"
            value={additionalPurpose}
            disabled={disabled}
            onChange={setAdditionalPurpose}
            choices={(["settings", "history", "overlay"] as const).map(
              (id) => ({ id, ...purposeCopy[id] }),
            )}
          />
        )}
        {step === "folder" && entry && !noSources && (
          <>
            <p>
              {purposeCopy[purpose(entry)].description} Choose only a file or
              folder configured when Agent Insights started.
            </p>
            <SourceChoice
              id="wizard-folder"
              label={purposeCopy[purpose(entry)].title}
              sources={status.sources}
              value={entry.sourceId}
              disabled={disabled}
              onChange={(sourceId) =>
                updateEntry({
                  sourceId,
                  relativePath: "",
                  layout:
                    purpose(entry) === "settings"
                      ? status.sources.find((source) => source.id === sourceId)
                          ?.kind === "file"
                        ? "catalog"
                        : "settings"
                      : entry.layout,
                })
              }
            />
            <details>
              <summary>Folder guidance and custom selection</summary>
              <p>
                {purpose(entry) === "settings"
                  ? "For the VS Code installation you used, choose its User settings folder. It contains the saved session information for the default setup and profiles. You may instead select an exact session-information file."
                  : purpose(entry) === "history"
                    ? "Choose the Copilot session-state folder used by that agent, or an exact retained events file. This is not your project folder."
                    : "Choose the agentSessionData folder used by VS Code, or an exact session database."}
              </p>
              {status.sources.find((source) => source.id === entry.sourceId)
                ?.kind === "directory" && (
                <>
                  <label htmlFor="wizard-subfolder">
                    File or folder inside this directory (optional)
                  </label>
                  <input
                    id="wizard-subfolder"
                    value={entry.relativePath}
                    disabled={disabled}
                    onChange={(event) =>
                      updateEntry({ relativePath: event.target.value })
                    }
                  />
                  <p>
                    Leave blank to use the selected folder itself. Paths must
                    stay inside it.
                  </p>
                  {purpose(entry) === "settings" && (
                    <label className="wizard-check">
                      <input
                        type="checkbox"
                        checked={entry.layout === "catalog"}
                        disabled={disabled}
                        onChange={(event) =>
                          updateEntry({
                            layout: event.target.checked
                              ? "catalog"
                              : "settings",
                          })
                        }
                      />
                      Use an exact session-information file inside this folder
                    </label>
                  )}
                </>
              )}
            </details>
          </>
        )}
        {step === "access" && (
          <>
            <p>
              Read retained sessions without changing files, VS Code settings,
              or logging. This review does not grant new access.
            </p>
            <ul className="wizard-searches">
              {entries.map((item) => {
                const source = status.sources.find(
                  (source) => source.id === item.sourceId,
                );
                return (
                  <li key={item.id}>
                    <strong>{purposeCopy[purpose(item)].title}</strong>
                    <code>
                      {source
                        ? sourceName(source, status.sources)
                        : "Unavailable"}
                      {item.relativePath && ` / ${item.relativePath}`}
                    </code>
                    {!source?.available && (
                      <p role="alert">
                        {source?.reason ??
                          "This configured file or folder is unavailable."}
                      </p>
                    )}
                    <div>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          setEditing(item.id);
                          setReturnToAccess(true);
                          setStep("folder");
                        }}
                      >
                        Edit{" "}
                        <span className="sr-only">
                          {source?.path} {item.relativePath}{" "}
                          {purposeCopy[purpose(item)].title}
                        </span>
                      </button>
                      {entries.length > 1 && (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            invalidate();
                            setEntries((previous) =>
                              previous.filter((entry) => entry.id !== item.id),
                            );
                          }}
                        >
                          Remove{" "}
                          <span className="sr-only">
                            {source?.path} {item.relativePath}{" "}
                            {purposeCopy[purpose(item)].title}
                          </span>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              disabled={disabled || entries.length >= 16 || noSources}
              onClick={() => {
                setAdditionalPurpose("");
                setStep("purpose");
              }}
            >
              Add saved session folder
            </button>
            <details>
              <summary>Full paths and read-only access</summary>
              {entries.map((item) => (
                <p key={item.id}>
                  <code>
                    {
                      status.sources.find(
                        (source) => source.id === item.sourceId,
                      )?.path
                    }{" "}
                    {item.relativePath}
                  </code>
                </p>
              ))}
              <p>
                Session content can be private. Finding and opening sessions
                does not send it to a model. Model-based analysis has a separate
                action and consent. To change allowed files or folders, restart
                with explicit source configuration.
              </p>
            </details>
            <label className="wizard-check">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={disabled}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I've reviewed the read-only access described above.
            </label>
          </>
        )}
        {step === "find" && (
          <>
            <p>
              Search only the configured session folders reviewed in the
              previous step. No search has run automatically.
            </p>
            {!ready && (
              <div role="status">
                <strong>
                  Agent Host discovery is not available in this installation.
                </strong>
                <p>
                  A compatible qualified helper is required; no fallback or new
                  logging is used.
                </p>
                <details>
                  <summary>Availability details</summary>
                  <p>
                    {reader?.reason ??
                      "Qualified Agent Host discovery is not installed."}
                  </p>
                </details>
              </div>
            )}
            <p>
              Retained messages and recorded activity may be incomplete. This
              step does not invoke a model.
            </p>
          </>
        )}
        {step === "sessions" && result && (
          <>
            <p>
              Checked at {new Date(result.finishedAtMs).toLocaleTimeString()}.
              Results are transient, not saved history.
            </p>
            {result.issues.length > 0 && (
              <div role="status">
                <strong>Some session files could not be used.</strong>
                <ul>
                  {result.issues.map((issue, index) => (
                    <li key={index}>
                      {issue.message}
                      <code>
                        {
                          status.sources.find(
                            (source) => source.id === issue.sourceId,
                          )?.path
                        }{" "}
                        {issue.relativePath}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!result.sessions.length && (
              <p role="status">
                No qualified retained sessions are available from these
                selections. This does not mean no activity occurred.
              </p>
            )}
            <Choices
              label="Retained session"
              value={selectedSession}
              disabled={disabled}
              onChange={setSelectedSession}
              choices={result.sessions.map((session) => ({
                id: session.id,
                title: session.sdkSessionId,
                unavailable: !session.selection,
                description: `${session.runtime === "copilot-agent-host" ? "Copilot Agent Host" : "Unqualified native backing"} · ${session.state}: ${session.reason}${session.archived ? " · Archived in the source catalog" : ""}`,
              }))}
            />
            <button
              type="button"
              disabled={disabled || !ready}
              onClick={() => void discover()}
            >
              Find sessions again
            </button>
          </>
        )}
        {step === "local" && (
          <Choices
            label="Local recording"
            value={localChoice}
            disabled={disabled}
            onChange={(value) => {
              resetSetup();
              setLocalChoice(value);
            }}
            choices={[
              {
                id: "file",
                title: "I have a recorded file",
                description:
                  "Find sessions in an existing compatible recording.",
              },
              {
                id: "record",
                title: "Help me record sessions",
                description: "Set up recording for future Local sessions.",
              },
            ]}
          />
        )}
        {step === "file" && !noSources && (
          <>
            <p>
              Use a Copilot Local recording. Ordinary transcripts, Agent Host
              history and Agent Debug Logs exports are not this recording
              format.
            </p>
            <SourceChoice
              id="wizard-file"
              label="Recorded session file or its containing folder"
              sources={status.sources}
              value={file.sourceId}
              disabled={disabled}
              onChange={(sourceId) => {
                invalidate();
                setFile((previous) => ({
                  ...previous,
                  sourceId,
                  relativePath: "",
                }));
              }}
            />
            {selectedFile?.kind === "directory" && (
              <>
                <label htmlFor="wizard-filename">
                  Recording filename inside this folder
                </label>
                <input
                  id="wizard-filename"
                  value={file.relativePath}
                  disabled={disabled}
                  onChange={(event) => {
                    invalidate();
                    setFile((previous) => ({
                      ...previous,
                      relativePath: event.target.value,
                    }));
                  }}
                  placeholder="copilot-otel.jsonl"
                />
              </>
            )}
            <p>
              Read files up to 64 MiB here. For larger recordings, use the
              explicit bounded scan in file tools. No model is called.
            </p>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onFileTools(file)}
            >
              Large recordings and file tools
            </button>
            {!status.readers.includes("vscode-otel-jsonl") && (
              <p role="status">
                The Local recording reader is not installed. No substitute
                format will be used.
              </p>
            )}
          </>
        )}
        {step === "file-sessions" && fileView && (
          <>
            {fileView.issues.length > 0 && (
              <details open>
                <summary>Recording limitations</summary>
                <ul>
                  {fileView.issues.map((issue, index) => (
                    <li key={index}>{issue.message}</li>
                  ))}
                </ul>
              </details>
            )}
            {!fileView.sessions.length && (
              <p role="status">
                No sessions could be identified in this read. That does not mean
                no activity occurred.
              </p>
            )}
            <Choices
              label="Recorded session"
              value={selectedSession}
              disabled={disabled}
              onChange={setSelectedSession}
              choices={fileView.sessions.map((session) => ({
                id: session.id,
                title: session.nativeId ?? session.id,
                description:
                  "Retained evidence from this recording; missing fields remain unavailable.",
              }))}
            />
          </>
        )}
        {step === "privacy" && (
          <>
            <p>
              Recording only applies to future sessions. Use a private writable
              folder on the machine recording them and follow organization
              policy. Full prompts and tool details can contain secrets; they
              are not automatically redacted.
            </p>
            <p>
              The example starts with content capture off. Full-content
              recording needs separate informed opt-in. Metadata alone cannot
              support every insight.
            </p>
            <label className="wizard-check">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={disabled}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I've reviewed the recording and privacy guidance.
            </label>
          </>
        )}
        {step === "recording" && (
          <>
            <ol>
              <li>Open VS Code User Settings (JSON).</li>
              <li>Merge the settings below, preserving unrelated settings.</li>
              <li>
                Use an absolute filename in your existing private writable
                folder.
              </li>
              <li>Reload the window before a new Local session.</li>
            </ol>
            <details>
              <summary>Show Local recording settings</summary>
              <pre>{`{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "/absolute/private/folder/copilot-otel.jsonl",
  "github.copilot.chat.otel.captureContent": false
}`}</pre>
            </details>
            <p>
              These are Local-specific instructions, not Agent Host settings.
              Managed settings must not be overridden.
            </p>
            <p>
              Before starting a session, verify effective User, profile,
              Workspace and Remote settings and inherited exporter variables on
              the exporting machine. Confirm content capture is off and output
              goes to your intended private file; the example alone cannot
              ensure this.
            </p>
          </>
        )}
        {step === "recorded" && (
          <>
            <p>
              Start a new Local session after setup and verify that a recording
              was created. Enabling capture cannot reconstruct earlier sessions.
            </p>
            <p>
              Then restart Agent Insights with explicit access to that file.
              This wizard does not enable recording or grant file access.
            </p>
          </>
        )}
      </div>
      <div className="wizard-footer">
        <button
          type="button"
          disabled={disabled || step === "assistant"}
          onClick={back}
        >
          Back
        </button>
        <span>
          {disabled
            ? "An operation is in progress"
            : "Read-only · no model calls"}
        </span>
        {!["unsupported", "unsure"].includes(step) && (
          <button
            type="button"
            className="primary"
            disabled={nextDisabled}
            onClick={() => void advance()}
          >
            {nextLabel}
          </button>
        )}
      </div>
    </section>
  );
}
