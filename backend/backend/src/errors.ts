export class HttpError extends Error {
  /** `extra` is merged into the JSON error body (e.g. retryAfterSeconds, limit details). */
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}
