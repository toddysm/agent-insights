/** Show one startup grant as information, or an actual choice among multiple grants; never changes authorization. */
import type { ReactElement } from "react";
import type { SourceLocation } from "../runtime/protocol.js";
import { sourceName } from "./source-names.js";

/** A controlled source choice; unavailable grants remain visible and selectable so failures are not hidden. */
interface SourceChoiceProps {
  readonly id: string;
  readonly label: string;
  readonly sources: readonly SourceLocation[];
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (id: string) => void;
}

/** Keep full paths visible in both modes; no one-option selector or internal identifier is rendered. */
export function SourceChoice({
  id,
  label,
  sources,
  value,
  disabled,
  onChange,
}: SourceChoiceProps): ReactElement {
  const selected = sources.find((source) => source.id === value);
  return (
    <div className="source-choice">
      {sources.length === 1 ? (
        <div>
          <span id={`${id}-label`}>{label}</span>
          <p aria-labelledby={`${id}-label`}>
            <strong>
              {selected
                ? sourceName(selected, sources)
                : "No file or folder selected"}
            </strong>
          </p>
        </div>
      ) : (
        <>
          <label htmlFor={id}>{label}</label>
          <select
            id={id}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            aria-describedby={`${id}-path`}
          >
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {sourceName(source, sources)}
                {source.available ? "" : " — Unavailable"}
              </option>
            ))}
          </select>
        </>
      )}
      <code id={`${id}-path`}>{selected?.path}</code>
      {selected && !selected.available && (
        <p role="alert">
          {selected.reason ?? "This file or folder cannot be accessed."} Restore
          access and refresh the configured files and folders. If unavailable at
          startup, correct the path and restart.
        </p>
      )}
    </div>
  );
}
