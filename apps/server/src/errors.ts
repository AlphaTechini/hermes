import type { AlertIssue } from "@hermes/shared";

/** Error with an HTTP status and a stable machine code; rendered as {error:{code,message}}. */
export class HermesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: AlertIssue[],
  ) {
    super(message);
    this.name = "HermesError";
  }
}

export const notFound = (what = "resource") => new HermesError(404, "not_found", `${what} not found`);
export const badRequest = (message: string, code = "bad_request") => new HermesError(400, code, message);
export const conflict = (message: string, code = "conflict") => new HermesError(409, code, message);
