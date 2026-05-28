import { getOrCreateOperatorToken, getWriteGrantToken } from "./workspace.js";

// Use localhost or environment variable
export const REVIT_BRIDGE_URL = process.env.REVIT_BRIDGE_URL || "http://localhost:5000";

export async function callRevit<T = unknown>(path: string, method: string = "GET", body?: unknown): Promise<T> {
  const token = getOrCreateOperatorToken();
  const serializedBody =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const upperMethod = String(method || "GET").trim().toUpperCase();

  const doFetch = async (): Promise<Response> => {
    const writeGrant = getWriteGrantToken();
    const options: RequestInit = {
      method: upperMethod,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Operator-Token": token } : {}),
        ...(writeGrant ? { "X-Operator-Write-Grant": writeGrant } : {}),
      },
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    };

    return await fetch(`${REVIT_BRIDGE_URL}${path}`, options);
  };

  let response = await doFetch();
  if (!response.ok) {
    let details = "";
    try { details = await response.text(); } catch { /* ignore */ }

    const isGrantError =
      response.status === 403 &&
      /write requires approval|x-operator-write-grant|write grant/i.test(details);

    // Write grant files can refresh in the add-in moments before a write.
    // Retry once so MCP calls recover without manual mode toggling.
    if (isGrantError && upperMethod !== "GET" && path !== "/revit/write-grant-status") {
      await new Promise(resolve => setTimeout(resolve, 150));
      response = await doFetch();
      if (response.ok) return (await response.json()) as T;
      try { details = await response.text(); } catch { /* ignore */ }
    }

    throw new Error(`Revit Bridge responded with status ${response.status}${details ? `: ${details}` : ""}`);
  }
  return (await response.json()) as T;
}
