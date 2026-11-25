/** Compact search-entry controls; disclosure never changes source access or starts discovery. */
import type { ReactElement } from "react";
import type { SourceLocation } from "../runtime/protocol.js";
import { SourceChoice } from "./source-choice.js";
import { sourceName } from "./source-names.js";

/** Return correction guidance, or null for a syntactically confined path; runtime filesystem/link containment remains authoritative. */
export function searchLocationError(relativePath: string): string | null {
  if (relativePath.length > 4096 || relativePath.includes("\0"))
    return "Use a path of at most 4096 characters without null characters.";
  if (/^[\\/]|^[a-z]:/i.test(relativePath))
    return "Use a relative file or subfolder inside the selected folder, not a full path.";
  let depth = 0;
  for (const part of relativePath.split(/[\\/]/)) {
    if (part === "..") {
      if (depth === 0)
        return "Keep the file or subfolder inside the selected folder; this path goes outside it.";
      depth--;
    } else if (part && part !== ".") depth++;
  }
  return null;
}

/** Parent retains stable entry identity, disclosure state, selection edits, operation locks and removal focus. */
interface SearchLocationProps {
  readonly id: number;
  readonly index: number;
  readonly sourceId: string;
  readonly relativePath: string;
  readonly expanded: boolean;
  readonly sources: readonly SourceLocation[];
  readonly disabled: boolean;
  readonly last: boolean;
  readonly onToggle: () => void;
  readonly onChange: (selection: {
    sourceId?: string;
    relativePath?: string;
  }) => void;
  readonly onRemove: () => void;
}

/** Keep identity, scope and problems visible while closed; removing a row never revokes its grant or deletes files. */
export function SearchLocation({
  id,
  index,
  sourceId,
  relativePath,
  expanded,
  sources,
  disabled,
  last,
  onToggle,
  onChange,
  onRemove,
}: SearchLocationProps): ReactElement {
  const source = sources.find((item) => item.id === sourceId);
  const name = source ? sourceName(source, sources) : "No location selected";
  const pathError =
    source?.kind === "directory" ? searchLocationError(relativePath) : null;
  return (
    <li
      className={`wizard-search-location${pathError || !source?.available ? " has-problem" : ""}`}
    >
      <div className="wizard-search-heading">
        <button
          id={`wizard-location-${id}`}
          className="wizard-location-toggle"
          type="button"
          disabled={disabled}
          aria-expanded={expanded}
          aria-controls={`wizard-location-editor-${id}`}
          onClick={onToggle}
        >
          <span className="wizard-location-chevron" aria-hidden="true">
            {expanded ? "-" : "+"}
          </span>
          <span className="wizard-location-summary">
            <span className="wizard-location-title">
              <strong>{name}</strong>
              <span
                className={`status-tag ${pathError || !source?.available ? "warning" : ""}`}
              >
                {!source?.available
                  ? "Unavailable"
                  : pathError
                    ? "Selection needs attention"
                    : "Accessible"}
              </span>
            </span>
            <span className="sr-only">Search location {index + 1}</span>
            <code>{source?.path ?? "Choose a configured file or folder."}</code>
            <span className="wizard-location-name">
              {source?.kind === "file"
                ? "This file only"
                : relativePath
                  ? `Selection within folder: ${relativePath}`
                  : "Whole folder"}
            </span>
          </span>
        </button>
        <button
          className="wizard-location-remove"
          type="button"
          disabled={disabled || last}
          aria-describedby={last ? "wizard-search-limit" : undefined}
          onClick={onRemove}
        >
          Remove
          <span className="sr-only">
            {" "}
            {source?.path} {relativePath} Search location {index + 1}
          </span>
        </button>
      </div>
      <div
        id={`wizard-location-editor-${id}`}
        className="wizard-location-editor"
        hidden={!expanded}
      >
        <SourceChoice
          id={`wizard-folder-${id}`}
          label={`Source ${index + 1}`}
          sources={sources}
          value={sourceId}
          disabled={disabled}
          onChange={(next) => onChange({ sourceId: next, relativePath: "" })}
        />
        {source?.kind === "directory" && (
          <>
            <label htmlFor={`wizard-subfolder-${id}`}>
              File or subfolder (optional)
            </label>
            <input
              id={`wizard-subfolder-${id}`}
              value={relativePath}
              disabled={disabled}
              aria-invalid={pathError ? true : undefined}
              aria-describedby={`wizard-subfolder-help-${id}${pathError ? ` wizard-subfolder-error-${id}` : ""}`}
              onChange={(event) =>
                onChange({ relativePath: event.target.value })
              }
            />
            <p id={`wizard-subfolder-help-${id}`}>
              Leave blank to use the whole folder. Paths must stay inside it.
              For example, <code>profiles/example</code> selects one profile, or{" "}
              <code>session-example/events.jsonl</code> selects a saved file. To
              allow somewhere else, use Add a file or folder above.
            </p>
            {pathError && (
              <p
                id={`wizard-subfolder-error-${id}`}
                className="alert"
                role="alert"
              >
                {pathError} Your selection is kept so you can correct it.
              </p>
            )}
          </>
        )}
        <button type="button" disabled={disabled} onClick={onToggle}>
          Done
          <span className="sr-only"> editing Search location {index + 1}</span>
        </button>
      </div>
    </li>
  );
}
