/** Explicit path admission for the current app run; no browser upload, native picker or persistent path storage. */
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import type { AddLocationRequest } from "../runtime/protocol.js";

/** Parent owns admission/status and an optional harness-specific example; examples never select paths. */
interface LocationAddProps {
  readonly open: boolean;
  readonly disabled: boolean;
  readonly onOpen: (open: boolean) => void;
  readonly onAdd: (selection: AddLocationRequest) => Promise<void>;
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly example?: string;
}

/** Keep path entry reachable with or without existing locations; display backend errors without implying OS permissions changed. */
export function SourceLocationAdd({
  open,
  disabled,
  onOpen,
  onAdd,
  trigger,
  example = "/path/to/session-data",
}: LocationAddProps): ReactElement | null {
  const [path, setPath] = useState("");
  const [kind, setKind] = useState<AddLocationRequest["kind"]>("directory");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      if (!disabled) input.current?.focus();
    } else if (wasOpen.current && !disabled) {
      wasOpen.current = false;
      trigger.current?.focus();
    }
  }, [open, disabled, error, trigger]);

  /** Submit only on explicit confirmation; parent validates the path, and rejection leaves the form and input intact. */
  async function add(): Promise<void> {
    setError("");
    try {
      await onAdd({ path, kind });
      setPath("");
      onOpen(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The location could not be added. Check its path and access, then try again.",
      );
    }
  }

  if (!open) return null;
  return (
    <div className="location-add">
      <form
        id="location-add-form"
        aria-labelledby="location-add-heading"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <h4 id="location-add-heading">Add a location</h4>
        <p>
          Enter the full path to an existing file or folder on the computer
          running Agent Insights.
        </p>
        <label htmlFor="location-add-kind">Location type</label>
        <select
          id="location-add-kind"
          value={kind}
          disabled={disabled}
          onChange={(event) => {
            setKind(event.target.value === "file" ? "file" : "directory");
            setError("");
          }}
        >
          <option value="directory">Folder</option>
          <option value="file">File</option>
        </select>
        <label htmlFor="location-add-path">Full file or folder path</label>
        <input
          ref={input}
          id="location-add-path"
          value={path}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          maxLength={4096}
          placeholder="/path/to/session-data"
          aria-invalid={error ? true : undefined}
          aria-describedby={`location-add-help${error ? " location-add-error" : ""}`}
          onChange={(event) => {
            setPath(event.target.value);
            setError("");
          }}
        />
        <p id="location-add-help">
          For example, <code>{example}</code>. Use the path syntax of the
          computer running Agent Insights. Choose Add location to allow read access for this app run
          only. A folder includes supported files inside it, within existing
          limits. Your computer&apos;s file permissions still apply. Nothing is
          searched and no model is called.
        </p>
        {error && (
          <p id="location-add-error" className="alert" role="alert">
            {error} Check the full path, selected type and file permissions,
            then try again.
          </p>
        )}
        <div className="wizard-location-controls">
          <button type="submit" className="primary" disabled={disabled}>
            Add location
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onOpen(false);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
