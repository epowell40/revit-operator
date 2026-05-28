import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

export type OcrCapabilities = {
  ocrReady: boolean;
  provider: "tesseract-exe" | "tesseract-js" | "none";
  tesseractExe: string | null;
  hint?: string;
  remediation_once?: boolean;
};

let remediationShown = false;

function onceHint(): { hint?: string; remediation_once?: boolean } {
  if (remediationShown) return {};
  remediationShown = true;
  const workspace = ensureWorkspaceLayout().root;
  const hint = [
    "OCR is not configured.",
    "Install Tesseract OCR and either:",
    "- put `tesseract` on PATH, or",
    "- set OPERATOR_TESSERACT_PATH to the full path (e.g. C:\\\\Program Files\\\\Tesseract-OCR\\\\tesseract.exe).",
    `Workspace root: ${workspace}`,
  ].join(" ");
  return { hint, remediation_once: true };
}

function resolveTesseractExeFromEnv(): string | null {
  const tesseractFromEnv = (process.env.OPERATOR_TESSERACT_PATH || "").trim();
  if (!tesseractFromEnv) return null;
  try {
    const full = path.resolve(tesseractFromEnv);
    if (fs.existsSync(full)) return full;
  } catch {
    // ignore
  }
  return tesseractFromEnv; // best-effort; may still be valid for spawn
}

async function canRunTesseract(exe: string, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(exe, ["--version"], { windowsHide: true });
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill(); } catch { /* ignore */ }
        resolve(false);
      }, Math.max(200, timeoutMs));
      child.on("error", () => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function getOcrCapabilities(): Promise<OcrCapabilities> {
  const envExe = resolveTesseractExeFromEnv();
  if (envExe) {
    const ok = await canRunTesseract(envExe, 1500);
    if (ok) return { ocrReady: true, provider: "tesseract-exe", tesseractExe: envExe };
  }

  const okPath = await canRunTesseract("tesseract", 1500);
  if (okPath) return { ocrReady: true, provider: "tesseract-exe", tesseractExe: "tesseract" };

  // Fallback: in-process OCR via tesseract.js is opt-in; it can be slow or
  // incompatible with some Node worker runtimes on Windows.
  const jsEnabled = /^(1|true|yes|on)$/i.test((process.env.OPERATOR_ENABLE_TESSERACT_JS ?? "").trim());
  if (!jsEnabled) return { ocrReady: false, provider: "none", tesseractExe: null, ...onceHint() };
  try {
    await import("tesseract.js");
    return { ocrReady: true, provider: "tesseract-js", tesseractExe: null };
  } catch {
    return { ocrReady: false, provider: "none", tesseractExe: null, ...onceHint() };
  }
}
