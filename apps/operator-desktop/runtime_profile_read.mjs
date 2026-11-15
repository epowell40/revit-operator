/** Retry only the idempotent profile GET, never a provider call or desktop action. */
/** Refresh unavailable/expired runtime custody through the host reader. A
 * refresh return is not authority: only the host's revalidated cache is read.
 * This neither extends its TTL nor grants model/native access by itself. */
export async function runtimeProfileForAccess(current,refresh){
  const profile=current();
  if(profile?.general_agent===true)return profile;
  await refresh();
  return current();
}

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

/** Exact local/self-host handshake on the configured loopback service.
 * Availability is not native write authority; existing per-task grants remain required. */
export function isLocalGeneralAgentHandshake({env,backendProfile:profile,backendUrl}) {
  const mode=env?.REVIT_OPERATOR_MODE;
  if(!["local","self_hosted"].includes(mode) || env.OPERATOR_TOOL_EXPOSURE_PROFILE!=="general"
    || env.OPERATOR_AUTH_MODE!=="shared_token" || ["1","true","yes","on"].includes(String(env.OPERATOR_HOSTED_ENABLED??"").toLowerCase()))return false;
  let url;try{url=new URL(backendUrl);}catch{return false;}
  return url.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)
    && !url.username && !url.password && url.pathname==="/" && !url.search && !url.hash
    && profile?.schema==="revit-operator.sidecar-agent-profile.v1" && profile.source==="backend_environment"
    && profile.runtime_mode===mode && profile.tool_exposure_profile==="general" && profile.capability_profile==="general_agent"
    && profile.general_agent_ready===true && profile.reason_code==="GENERAL_AGENT_LOCAL_READY";
}
