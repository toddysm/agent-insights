/**
 * Frame borrowed UTF-8 bytes into original JSON Lines records without filesystem
 * access or persistence. Callers own input limits and decide whether damaged
 * independent records can be skipped or dependent replay must stop.
 */
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { ReaderInput } from "../contracts.js";

/** Physical line identity and parse outcome; failures never contain captured text. */
export type JsonLine =
  | {
      readonly line: number;
      readonly byteOffset: number;
      readonly byteLength: number;
      readonly terminated: boolean;
      readonly value: unknown;
      readonly recordId: string;
    }
  | {
      readonly line: number;
      readonly byteOffset: number;
      readonly byteLength: number;
      readonly terminated: boolean;
      readonly error: "encoding" | "json" | "oversized";
    };

/** Code-owned framing limits and payload-free physical-line observations, including blanks. */
export interface JsonLinePolicy {
  readonly maxRecordBytes: number;
  readonly onLine?: (line: {
    line: number;
    byteOffset: number;
    byteLength: number;
    terminated: boolean;
    blank: boolean;
  }) => void;
}

/**
 * Decode one physical line and parse JSON; blank lines retain numbering but emit nothing.
 * Contiguous input is borrowed synchronously; only fragmented lines allocate a joined byte buffer.
 * @param parts - Borrowed byte slices comprising this line, excluding LF.
 * @param line - One-based physical line number, including blank lines.
 * @param terminated - Whether LF ended the record, rather than end of input.
 * @returns Parsed value, controlled failure or null for whitespace-only input.
 */
function decode(
  parts: readonly Uint8Array[],
  line: number,
  terminated: boolean,
): (
  | Omit<Extract<JsonLine, { value: unknown }>, "byteOffset" | "byteLength">
  | Omit<Extract<JsonLine, { error: string }>, "byteOffset" | "byteLength">
) | null {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const contiguous = parts.length === 1 ? parts[0] : undefined;
  const bytes = contiguous ?? new Uint8Array(size);
  if (!contiguous) {
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: line !== 1,
    }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { line, terminated, error: "encoding" };
  }
  if (text.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    return {
      line,
      terminated,
      value,
      recordId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { line, terminated, error: "json" };
  }
}

/**
 * Consume the supplied stream only, retaining at most one unfinished physical line.
 * @param input - Caller-bounded bytes with the read-owned cancellation signal.
 * @returns Records in source order; a complete final record needs no newline.
 * @throws Rejects on cancellation or stream failure; yields controlled syntax/encoding failures.
 */
export async function* jsonLines(
  input: ReaderInput,
  policy: JsonLinePolicy = { maxRecordBytes: 64 * 1024 * 1024 },
): AsyncGenerator<JsonLine> {
  if (!Number.isSafeInteger(policy.maxRecordBytes) || policy.maxRecordBytes < 1)
    throw new RangeError("Record byte limit must be a positive safe integer");
  input.signal.throwIfAborted();
  let parts: Uint8Array[] = [];
  let line = 1;
  let size = 0;
  let byteOffset = 0;
  let oversized = false;
  /** Exclude oversized lines before collecting/decoding; retain only a bounded unfinished record. */
  const append = (part: Uint8Array): void => {
    size += part.byteLength;
    if (size > policy.maxRecordBytes) {
      oversized = true;
      parts = [];
    } else if (!oversized && part.byteLength) parts.push(part);
  };
  /** Finish a physical record; its byte coordinates exclude LF but include CR when present. */
  const finish = (terminated: boolean): JsonLine | null => {
    const record = oversized
      ? { line, terminated, error: "oversized" as const }
      : decode(parts, line, terminated);
    policy.onLine?.({ line, byteOffset, byteLength: size, terminated, blank: record === null });
    const result = record === null ? null : { ...record, byteOffset, byteLength: size };
    byteOffset += size + (terminated ? 1 : 0);
    line++;
    size = 0;
    parts = [];
    oversized = false;
    return result;
  };
  for await (const chunk of input.bytes) {
    input.signal.throwIfAborted();
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index++) {
      if (chunk[index] !== 10) continue;
      input.signal.throwIfAborted();
      append(chunk.subarray(start, index));
      const record = finish(true);
      start = index + 1;
      if (record !== null) yield record;
      if (line % 256 === 0) {
        await setImmediate();
        input.signal.throwIfAborted();
      }
    }
    if (start < chunk.byteLength) append(chunk.subarray(start));
    await setImmediate();
    input.signal.throwIfAborted();
  }
  input.signal.throwIfAborted();
  if (size > 0) {
    const record = finish(false);
    if (record !== null) yield record;
  }
}
