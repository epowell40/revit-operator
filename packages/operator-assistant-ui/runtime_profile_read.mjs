/** Retry only the idempotent profile GET, never a provider call or desktop action. */
export async function readRuntimeProfileWithTransportRetry(readJson, { signal, onFailure = () => {} } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (signal?.aborted) throw signal.reason || Object.assign(new Error("Profile read aborted"), { name: "AbortError" });
      const data = await readJson("/desktop/computer/config", { method: "GET", signal });
      return data?.sidecar_agent_profile && typeof data.sidecar_agent_profile === "object"
        ? data.sidecar_agent_profile : null;
    } catch (error) {
      const code = error?.cause?.code;
      const retry = attempt === 1 && !signal?.aborted && error?.name === "TypeError"
        && error?.message === "fetch failed" && ["ECONNRESET", "UND_ERR_SOCKET"].includes(code)
        && error?.status === undefined;
      onFailure({ attempt, code: ["ECONNRESET", "UND_ERR_SOCKET"].includes(code) ? code : "profile_read_failed",
        status: Number.isInteger(error?.status) ? error.status : null, retry });
      if (!retry) throw error;
    }
  }
}
