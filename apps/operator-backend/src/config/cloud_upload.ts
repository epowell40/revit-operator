import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

export type CloudUploadMode = "off" | "once" | "watch";

export type CloudUploadConfig = {
  upload_url?: string;
  upload_token?: string;
  mode?: CloudUploadMode;
  updated_at?: string;
};

export function cloudUploadConfigPath(): string {
  const layout = ensureWorkspaceLayout();
  return path.join(layout.config, "cloud_upload.json");
}

export function readCloudUploadConfig(): CloudUploadConfig | null {
  try {
    const p = cloudUploadConfigPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) return null;
    const parsed: any = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object") return null;

    const upload_url = typeof parsed.upload_url === "string" ? parsed.upload_url.trim() : "";
    const upload_token = typeof parsed.upload_token === "string" ? parsed.upload_token.trim() : "";
    const modeRaw = typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
    const mode: CloudUploadMode | undefined = modeRaw === "watch" || modeRaw === "once" || modeRaw === "off" ? (modeRaw as any) : undefined;
    const updated_at = typeof parsed.updated_at === "string" ? parsed.updated_at.trim() : "";

    return {
      ...(upload_url ? { upload_url } : {}),
      ...(upload_token ? { upload_token } : {}),
      ...(mode ? { mode } : {}),
      ...(updated_at ? { updated_at } : {})
    };
  } catch {
    return null;
  }
}

export function writeCloudUploadConfig(next: CloudUploadConfig): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const p = cloudUploadConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const updated_at = new Date().toISOString();
    const out: CloudUploadConfig = {
      ...(typeof next.upload_url === "string" && next.upload_url.trim() ? { upload_url: next.upload_url.trim() } : {}),
      ...(typeof next.upload_token === "string" && next.upload_token.trim() ? { upload_token: next.upload_token.trim() } : {}),
      ...(typeof next.mode === "string" && next.mode ? { mode: next.mode } : {}),
      updated_at
    };

    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
    fs.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

