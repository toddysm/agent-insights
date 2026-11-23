/** Presentation-only names for startup grants. Paths remain visible and IDs remain unchanged in requests. */
import type { SourceLocation } from "../runtime/protocol.js";

/** Use the shortest distinguishing trailing path; exact duplicate paths retain their full configured spelling. */
export function sourceName(
  source: SourceLocation,
  sources: readonly SourceLocation[],
): string {
  const parts = source.path.split(/[\\/]/).filter(Boolean);
  if (!parts.length || /^[A-Za-z]:[\\/]?$/.test(source.path))
    return source.path;
  for (let depth = 1; depth <= parts.length; depth++) {
    const suffix = parts.slice(-depth).join(" / ");
    if (
      sources.filter(
        (item) =>
          item.path.split(/[\\/]/).filter(Boolean).slice(-depth).join(" / ") ===
          suffix,
      ).length === 1
    )
      return suffix;
  }
  return source.path;
}
