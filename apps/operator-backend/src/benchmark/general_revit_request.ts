import { assertGeneralRevitInstructionRuntime } from "./general_revit_instruction_preflight.js";

type JsonRecord = Record<string, unknown>;
export function createGeneralRevitRequest(expected: () => JsonRecord | null, fetchImpl: typeof fetch = fetch) {
  return async function requestJson(baseUrl: string, pathname: string, options: RequestInit = {}, timeoutMs = 120_000): Promise<JsonRecord> {
    const instructionExpectation = expected();
    if (instructionExpectation && String(options.method || "GET").toUpperCase() === "POST"
      && ["/api/computer/run", "/api/chat", "/api/chat/stream"].includes(pathname)) {
      assertGeneralRevitInstructionRuntime(await requestJson(baseUrl, "/api/backend/health", {}, 30_000), instructionExpectation);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`${pathname} exceeded ${timeoutMs}ms.`)), timeoutMs);
    try {
      const origin = new URL(baseUrl).origin;
      const response = await fetchImpl(new URL(pathname, `${baseUrl}/`), {
        ...options,
        headers: { "content-type": "application/json", origin, ...(options.headers || {}) },
        signal: controller.signal
      });
      const text = await response.text();
      let body: unknown = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname} returned ${response.status}: ${text.slice(0, 1000)}`);
      return body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
    } finally { clearTimeout(timeout); }
  };
}
