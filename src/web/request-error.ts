/** Share displayable transport diagnostics without retaining response bodies or captured content. */

/** Carry a validated backend code or a browser-detected response failure so recovery never matches display text. */
export class RequestError extends Error {
  /** Retain only the public code/message, not the response or a decoder error containing payload text. */
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
