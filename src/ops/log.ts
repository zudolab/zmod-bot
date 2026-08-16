/**
 * Structured logging. Never pass a prompt body, a reference body, polish
 * input, or a credential as a field — see CLAUDE.md non-negotiable:
 * those are customer-facing business text. Callers pass identifiers
 * (job id, slug, event id), never the text itself. Implementation is
 * left to whichever sub-task first needs it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

export function log(level: LogLevel, message: string, fields?: LogFields): void {
  throw new Error("not implemented: log");
}
