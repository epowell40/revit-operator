/** Retain the original exception even when V2 recovers a terminal result. */
export function recordChatExecutionFailureDiagnostic(input: Readonly<{
  session_id: string;
  message_id: string;
  error: unknown;
  stream: boolean;
}>, sinks: Readonly<{
  append_event: (sessionId: string, payload: Record<string, unknown>) => void;
  capture_bundle: (sessionId: string, messageId: string, error: unknown, stream: boolean) => void;
  log_error: (payload: Record<string, unknown>) => void;
}>): string {
  const message = input.error instanceof Error ? input.error.message : "Unknown error";
  const payload = {
    message_id: input.message_id,
    message,
    ...(input.error instanceof Error && typeof input.error.stack === "string" ? { stack: input.error.stack } : {})
  };
  try { sinks.append_event(input.session_id, payload); } catch { /* V2 settlement still owns the result. */ }
  try { sinks.capture_bundle(input.session_id, input.message_id, input.error, input.stream); } catch { /* best effort */ }
  try { sinks.log_error({ session_id: input.session_id, message_id: input.message_id, error: message, stream: input.stream }); }
  catch { /* V2 settlement still owns the result. */ }
  return message;
}

/** Provider startup can settle V2 inside the brain, before the HTTP catch runs. */
export function recordProviderStartFailureDiagnostic(input: Readonly<{
  session_id: string;
  message_id: string;
  error: unknown;
}>, append_event: (sessionId: string, payload: Record<string, unknown>) => void): void {
  const error = input.error;
  const payload = {
    message_id: input.message_id,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && typeof error.stack === "string" ? { stack: error.stack } : {})
  };
  try { append_event(input.session_id, payload); } catch { /* Preserve V2 settlement if diagnostics fail. */ }
}
