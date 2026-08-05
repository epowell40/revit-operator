export function formatCodexPermissionSummary(ctx: unknown): { summary: string; signature: string } | null {
  try {
    const ui: any = (ctx as any)?.ui;
    if (!ui || typeof ui !== "object") return null;
    const approvalMode = typeof ui.approval_mode === "string" ? ui.approval_mode.trim() : "";
    const wg: any = ui.write_grant;
    const nativeApi: any = ui.native_api_policy;
    let wgSummary = "off";
    let wgSig = "off";
    if (wg && typeof wg === "object") {
      const active = wg.active === true;
      const mode = typeof wg.mode === "string" ? wg.mode.trim() : "";
      const exp = typeof wg.expires_at_utc === "string" ? wg.expires_at_utc.trim() : "";
      const uses = Number.isFinite(wg.uses_remaining) ? String(wg.uses_remaining) : "";
      const err = typeof wg.error === "string" ? wg.error.trim() : "";
      if (!active && err) wgSummary = `error (${err})`;
      else if (active) wgSummary = [`active`, mode ? `mode=${mode}` : null, uses ? `uses_remaining=${uses}` : null, exp ? `expires_at_utc=${exp}` : null].filter(Boolean).join(" ") || "active";
      wgSig = [active ? "1" : "0", mode || "", uses || "", exp || "", err || ""].join("|");
    }
    const nativeProfile = nativeApi && typeof nativeApi === "object" && typeof nativeApi.profile === "string" ? nativeApi.profile.trim() : "";
    const nativeLocked = nativeApi && typeof nativeApi === "object" && nativeApi.locked === true;
    const nativeSummary = nativeProfile ? ` native_api_profile=${nativeProfile}${nativeLocked ? " (locked)" : ""};` : "";
    return {
      summary: `Bridge permissions: approval_mode=${approvalMode || "unknown"}; write_grant=${wgSummary};${nativeSummary}`.replace(/;\s*$/, "."),
      signature: [approvalMode || "", wgSig, [nativeProfile || "", nativeLocked ? "1" : "0"].join("|")].join("||")
    };
  } catch {
    return null;
  }
}
