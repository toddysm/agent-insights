/** Show one configured grant as information, or a choice among grants; admission is a separate explicit action. */
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
        <p>
          <span>{label}: </span>
          <strong>
            {selected
              ? sourceName(selected, sources)
              : "No file or folder selected"}
          </strong>
        </p>
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
          access and choose Check locations in the shared access workspace. If
          unavailable at startup or its path changed, use Add a file or folder to add it explicitly.
        </p>
      )}
    </div>
  );
}
