/**
 * Guided source discovery over explicitly configured grants, including UI-added
 * current-run paths. Harness-specific recognition runs only on Find sessions;
 * no installation inference, OS permission changes, storage or model call occurs.
 */
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import type { z } from "zod";
import type { ReadView } from "../evidence/contracts.js";
import {
  discoveryResultSchema,
  type DiscoveryRequest,
  type DiscoveryResult,
  type ReadRequest,
  type ReadSetRequest,
  type RuntimeStatus,
  type AddLocationRequest,
} from "../runtime/protocol.js";
import { SourceChoice } from "./source-choice.js";
import { sourceName } from "./source-names.js";
import { SourceLocationAdd } from "./source-location-add.js";

/** Parent navigation returns to this workspace without discarding its configured selections. */
export interface SourceDiscoveryHandle {
  /** Clear report/results through onStart and focus configured access without selecting a session type or checking automatically. */
  reviewLocations(): void;
  /** Discard old results and return to the current session type's setup with its selections retained. */
  findAnotherSession(): void;
}

/** Check/admission validity survives wizard resets; only an explicit successful check or addition clears failure. */
export type LocationCheckState = "idle" | "checking" | "checked" | "failed";

/** Parent owns authenticated transport, explicit admission, check validity, report handoff, operation locks and read feedback. */
interface DiscoveryProps {
  readonly ref: Ref<SourceDiscoveryHandle>;
  readonly status: RuntimeStatus;
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly locationCheck: LocationCheckState;
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
  /** Refresh configured availability and invalidate backend evidence; reject failures rather than reporting stale status as success. */
  readonly onCheckLocations: () => Promise<void>;
  /** Validate/register a current-run location and refresh shared status; reject admission/transport failures. */
  readonly onAddLocation: (selection: AddLocationRequest) => Promise<string>;
}

/** Stable entry identity is separate from its grant and confined path; the runtime recognizes Agent Host layouts. */
interface SearchEntry {
  readonly id: number;
  readonly sourceId: string;
  readonly relativePath: string;
}

/** Branch stages are UI state, never producer identity or proof that a capture is supported. */
type Step =
  | "assistant"
  | "session"
  | "unsupported"
  | "unsure"
  | "locations"
  | "access"
  | "sessions"
  | "local"
  | "file"
  | "privacy"
  | "recording"
  | "recorded"
  | "file-sessions";
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
  ref,
  status,
  hidden,
  disabled,
  locationCheck,
  feedback,
  send,
  onStart,
  onBusy,
  onRead,
  onReadFile,
  onOpenFile,
  onFileTools,
  onCheckLocations,
  onAddLocation,
}: DiscoveryProps): ReactElement {
  const [step, setStep] = useState<Step>("assistant");
  const [assistant, setAssistant] = useState("");
  const [sessionType, setSessionType] = useState("");
  const [entries, setEntries] = useState<readonly SearchEntry[]>([
    {
      id: 1,
      sourceId: status.sources[0]?.id ?? "",
      relativePath: "",
    },
  ]);
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
  const [addOpen, setAddOpen] = useState(false);
  const sequence = useRef(1);
  const generation = useRef(0);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const admittedSource = useRef<string | null>(null);
  const firstStep = useRef(true);
  const locationReturn = useRef<Step>("assistant");
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
    if (hidden) return;
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    body.current?.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
  }, [step, hidden]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  useImperativeHandle(ref, () => ({
    reviewLocations() {
      locationReturn.current =
        step === "locations"
          ? locationReturn.current
          : step === "sessions"
            ? "access"
            : step === "file-sessions"
              ? "file"
              : step;
      invalidate();
      setStep("locations");
      if (!hidden) heading.current?.focus({ preventScroll: true });
    },
    findAnotherSession() {
      invalidate();
      setStep(
        sessionType === "Agent Host"
          ? "access"
          : sessionType === "Local"
            ? "file"
            : "assistant",
      );
    },
  }));

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
  function updateEntry(
    id: number,
    patch: Partial<Omit<SearchEntry, "id">>,
  ): void {
    invalidate();
    setEntries((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  /** Restart only wizard selections; grants, availability and the source safety boundary remain owned by the runtime. */
  function restart(): void {
    resetSetup();
    setAssistant("");
    setSessionType("");
    setStep("assistant");
  }

  /** Upstream changes clear dependent setup but retain the UI-added base location; Back retains current answers. */
  function resetSetup(): void {
    invalidate();
    setLocalChoice("");
    const sourceId = admittedSource.current ?? status.sources[0]?.id ?? "";
    setEntries([
      {
        id: ++sequence.current,
        sourceId,
        relativePath: "",
      },
    ]);
    setFile({
      sourceId,
      relativePath: "",
      format: "vscode-otel-jsonl",
    });
  }

  /** Explicitly check availability, preserving choices but dropping evidence/consent before either success or failure. */
  async function checkLocations(): Promise<void> {
    invalidate(true, true);
    const current = generation.current;
    try {
      await onCheckLocations();
    } catch (failure) {
      if (current === generation.current) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Configured locations could not be checked.",
        );
      }
    }
  }

  /** Select explicit additions without replacing reviewed Host locations; admission never starts discovery. */
  async function addLocation(selection: AddLocationRequest): Promise<void> {
    invalidate(true, true);
    if (step === "file-sessions") setStep("file");
    if (step === "sessions") setStep("access");
    const sourceId = await onAddLocation(selection);
    admittedSource.current = sourceId;
    setFile((previous) => ({ ...previous, sourceId, relativePath: "" }));
    if (sessionType === "Agent Host") {
      if (entries.some((entry) => entry.sourceId === sourceId && !entry.relativePath)) return;
      const empty = entries.find((entry) => !entry.sourceId);
      if (empty) {
        setEntries((previous) => previous.map((entry) => entry.id === empty.id ? { ...entry, sourceId, relativePath: "" } : entry));
      } else if (entries.length < 16) {
        const id = ++sequence.current;
        setEntries((previous) => [...previous, { id, sourceId, relativePath: "" }]);
      } else {
        setError("The location was added to configured access. A search can use up to 16 locations; remove a search location or change its Source choice to use the added location.");
      }
    } else {
      setEntries([{ id: ++sequence.current, sourceId, relativePath: "" }]);
    }
  }

  /** Search only on explicit submission. Transport/backend errors remain visible and never restore earlier sessions. */
  async function discover(): Promise<void> {
    invalidate(false, true);
    const current = generation.current;
    onBusy(true);
    try {
      const next = await send("/api/discover", discoveryResultSchema, {
        roots: entries.map(({ sourceId, relativePath }) => ({
          sourceId,
          relativePath,
          layout: "agent-host",
        })),
      } satisfies DiscoveryRequest);
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
      access: "session",
      locations: locationReturn.current,
      sessions: "access",
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
            ? "access"
            : sessionType === "Local"
              ? "local"
              : sessionType === "Not sure"
                ? "unsure"
                : "unsupported",
        );
        break;
      case "access":
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
      case "locations":
        break;
    }
  }

  const noSources = status.sources.length === 0;
  const nextDisabled =
    disabled ||
    (step === "assistant" && !assistant) ||
    (step === "session" && !sessionType) ||
    (step === "access" &&
      (noSources ||
        !ready ||
        !acknowledged ||
        unavailable ||
        locationCheck === "failed")) ||
    (step === "sessions" &&
      !result?.sessions.find((session) => session.id === selectedSession)
        ?.selection) ||
    (step === "local" && !localChoice) ||
    (step === "file" &&
      (!selectedFile?.available ||
        (selectedFile.kind === "directory" && !file.relativePath.trim()) ||
        locationCheck === "failed" ||
        !status.readers.includes("vscode-otel-jsonl"))) ||
    (step === "privacy" && !acknowledged) ||
    (step === "file-sessions" &&
      !fileView?.sessions.some((session) => session.id === selectedSession));
  const title: Record<Step, string> = {
    assistant: "Which coding assistant did you use?",
    session: "Which Copilot session option did you use?",
    unsupported: "Not supported",
    unsure: "Let's identify your session option",
    locations: "Configured access",
    access: "Choose your Agent Host sources",
    sessions: "Choose an Agent Host session",
    local: "Do you have a recorded session file?",
    file: "Find sessions in your recorded file",
    privacy: "Before recording future sessions",
    recording: "Enable Local session recording",
    recorded: "Return with your recorded file",
    "file-sessions": "Choose a recorded session",
  };
  const nextLabel =
    step === "access" || step === "file"
      ? "Find sessions"
      : step === "sessions" || step === "file-sessions"
        ? "Open report"
        : step === "recorded"
            ? "Back to file choice"
            : "Next";

  const locationControls = (
    <div className="location-check">
      <p
        className="checked"
        role={locationCheck === "checked" ? "status" : undefined}
      >
        {locationCheck === "checking"
          ? "Checking locations..."
          : locationCheck === "failed"
            ? "The check failed. Previously checked availability is shown; check again before finding sessions."
            : `${locationCheck === "checked" ? "Locations checked" : "Availability checked"} at ${new Date(status.checkedAtMs).toLocaleTimeString()}. Nothing was searched.`}
      </p>
      <button
        type="button"
        disabled={disabled || locationCheck === "checking"}
        onClick={() => void checkLocations()}
      >
        {locationCheck === "checking" ? "Checking..." : "Check locations"}
      </button>
    </div>
  );
  const startupGuidance = (
    <details>
      <summary>Prefer to provide locations when starting the app?</summary>
      <p>
        The terminal command is an optional way to supply initial locations.
        Replace the example path with your file or folder. Repeat <code>--source</code> for additional locations.
        Starting without <code>--source</code> is fine: use Add a file or folder here instead, without restarting.
      </p>
      <code>npm start -- --source /path/to/session-data</code>
    </details>
  );

  return (
    <section
      id="session-wizard"
      className="source-wizard"
      aria-labelledby="wizard-heading"
      hidden={hidden}
    >
      <div className="wizard-header">
        <div className="wizard-heading">
          <h2 id="wizard-heading">Find your sessions</h2>
          <button ref={addTrigger} type="button" disabled={disabled} aria-expanded={addOpen} aria-controls={addOpen ? "location-add-form" : undefined} onClick={() => setAddOpen(!addOpen)}>
            Add a file or folder
          </button>
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
        <SourceLocationAdd
          trigger={addTrigger}
          open={addOpen}
          disabled={disabled}
          onOpen={setAddOpen}
          onAdd={addLocation}
          example={sessionType === "Local"
            ? "/absolute/private/folder/copilot-otel.jsonl"
            : sessionType === "Agent Host"
              ? "/Users/example/.copilot/session-state"
              : "/path/to/session-data"}
        />
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
        {["access", "locations", "file"].includes(step) && locationControls}
        {["access", "locations", "file"].includes(step) && noSources && (
          <div role="status">
            <h4>No files or folders configured</h4>
            <p>
              Use Add a file or folder to provide your session location.
              No home, VS Code or project folder is selected automatically. No restart is needed.
            </p>
            {startupGuidance}
          </div>
        )}
        {step === "locations" && !noSources && (
          <>
            <p>
              These are the files and folders you have configured. Checking
              access does not search for sessions or open a report.
            </p>
            <ul className="source-list">
              {status.sources.map((source) => (
                <li key={source.id}>
                  <div>
                    <strong>{sourceName(source, status.sources)}</strong>
                    <code>{source.path}</code>
                    {source.reason && <p>{source.reason}</p>}
                  </div>
                  <span
                    className={`status-tag ${source.available ? "" : "warning"}`}
                  >
                    {source.available ? "Accessible" : "Unavailable"}
                  </span>
                </li>
              ))}
            </ul>
            {startupGuidance}
          </>
        )}
        {step === "access" && (
          <>
            <p>
              Agent Host needs VS Code&apos;s saved session information and
              Copilot&apos;s retained session history to identify your sessions.
              Choose their folders or exact files below; you do not need to
              assign file roles. Add the locations you want to search, then
              choose Find sessions.
            </p>
            <details>
              <summary>Where Agent Host saves sessions</summary>
              <ul>
                <li>
                  VS Code&apos;s <code>User</code> folder holds session
                  information, including profiles. Standard VS Code defaults are{" "}
                  <code>~/Library/Application Support/Code/User</code> on macOS,{" "}
                  <code>%APPDATA%\Code\User</code> on Windows and{" "}
                  <code>~/.config/Code/User</code> on Linux.
                </li>
                <li>
                  Copilot&apos;s default saved history is{" "}
                  <code>~/.copilot/session-state</code>. If the producer uses{" "}
                  <code>COPILOT_HOME</code>, choose its <code>session-state</code>{" "}
                  folder instead.
                </li>
                <li>
                  VS Code&apos;s <code>agentSessionData</code> folder can add
                  retained activity details. It is alongside <code>User</code>{" "}
                  in the VS Code user-data folder.
                </li>
              </ul>
              <p>
                Other editions, remote machines and custom user-data locations
                can differ. Use the locations from the setup that recorded the
                sessions. These examples are guidance only; nothing outside
                your selected sources is searched. Agent Host data is not a
                Copilot Local recording.
              </p>
            </details>
            {!ready && (
              <div role="status">
                <strong>Agent Host discovery is not available in this installation.</strong>
                <p>A compatible qualified helper is required; no fallback or new logging is used.</p>
                <details>
                  <summary>Availability details</summary>
                  <p>{reader?.reason ?? "Qualified Agent Host discovery is not installed."}</p>
                </details>
              </div>
            )}
          </>
        )}
        {step === "access" && !noSources && (
          <>
            <p>
              Choose from configured locations, or use Add a file or folder above.
              New locations last for this app run only. Nothing is searched automatically.
            </p>
            <ul className="wizard-searches">
              {entries.map((item, index) => {
                const source = status.sources.find(
                  (source) => source.id === item.sourceId,
                );
                return (
                  <li key={item.id}>
                    <div className="wizard-location-heading">
                      <div>
                        <h4>Search location {index + 1}</h4>
                      </div>
                      <span
                        className={`status-tag ${source?.available ? "" : "warning"}`}
                      >
                        {source?.available ? "Accessible" : "Unavailable"}
                      </span>
                    </div>
                    <SourceChoice
                      id={`wizard-folder-${item.id}`}
                      label={`Source ${index + 1}`}
                      sources={status.sources}
                      value={item.sourceId}
                      disabled={disabled}
                      onChange={(sourceId) => updateEntry(item.id, { sourceId, relativePath: "" })}
                    />
                    {item.relativePath && (
                      <p className="wizard-location-name">Selection within folder: {item.relativePath}</p>
                    )}
                    {source?.kind === "directory" && <details>
                      <summary>
                        Location and custom options
                        <span className="sr-only">
                          {" "}
                          for search location {index + 1}
                        </span>
                      </summary>
                          <label htmlFor={`wizard-subfolder-${item.id}`}>
                            File or subfolder (optional)
                          </label>
                          <input
                            id={`wizard-subfolder-${item.id}`}
                            value={item.relativePath}
                            disabled={disabled}
                            onChange={(event) =>
                              updateEntry(item.id, {
                                relativePath: event.target.value,
                              })
                            }
                          />
                          <p>
                            Leave blank to use the selected folder itself. Paths
                            must stay inside it. For another location, use Add a file or folder above.
                            For example, <code>profiles/example</code> selects one profile
                            inside User, or <code>session-example/events.jsonl</code> selects
                            one saved history file inside session-state.
                          </p>
                    </details>}
                    <div>
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
                            Search location {index + 1}
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
                invalidate();
                const sourceId = status.sources.find((source) => !entries.some((entry) => entry.sourceId === source.id))?.id ?? status.sources[0]?.id ?? "";
                const id = ++sequence.current;
                setEntries((previous) => [...previous, { id, sourceId, relativePath: "" }]);
              }}
            >
              Add another search location
            </button>
            {startupGuidance}
            <label className="wizard-check">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={disabled}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I've reviewed these locations for read-only access.
            </label>
          </>
        )}
        {step === "sessions" && result && (
          <>
            <p>
              Checked at {new Date(result.finishedAtMs).toLocaleTimeString()}.
              Results are transient, not saved history.
            </p>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                invalidate();
                setStep("access");
              }}
            >
              Review locations
            </button>
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
            {startupGuidance}
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
              onClick={() => {
                const selection = {
                  ...file,
                  relativePath: file.relativePath.trim(),
                };
                setFile(selection);
                onFileTools(selection);
              }}
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
              Then use Add a file or folder to provide that recording to Agent
              Insights. No restart is needed. This wizard does not enable recording.
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
        {!["unsupported", "unsure", "locations"].includes(step) && (
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
