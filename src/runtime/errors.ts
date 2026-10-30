/** Explicit, payload-free errors crossing the local runtime boundary. */
export class RuntimeError extends Error {
  /** Construct a public error from application-controlled codes and messages only. */
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

/** Translate known filesystem failures without exposing paths or source contents; propagate bugs. */
export function filesystemError(error: unknown): never {
  if (error instanceof RuntimeError) throw error;
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw new RuntimeError(
      "SOURCE_MISSING",
      "The source location is missing.",
      404,
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    throw new RuntimeError(
      "SOURCE_DENIED",
      "The source cannot be read with current permissions.",
      403,
    );
  }
  if (code === "ELOOP") {
    throw new RuntimeError(
      "SOURCE_LINK",
      "The source contains an unsafe or cyclic link.",
      403,
    );
  }
  if (code === "EIO" || code === "EBUSY") {
    throw new RuntimeError(
      "SOURCE_IO",
      "The source could not be read. Retry after checking its availability.",
      422,
    );
  }
  throw error;
}

/** Return the standard cancellation error without preserving an untrusted abort reason. */
export function cancelledRead(signal?: AbortSignal): RuntimeError {
  if (signal?.reason instanceof RuntimeError) return signal.reason;
  return new RuntimeError(
    "READ_CANCELLED",
    "The read was cancelled or superseded.",
    409,
  );
}
