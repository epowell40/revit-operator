import fs from "node:fs";
import path from "node:path";

export const CODEX_APP_SERVER_COMPATIBILITY = Object.freeze({
  codex_cli_version: "0.157.0",
  protocol_mode: "experimental",
  generated_at: "2026-09-26",
  generated_typescript: {
    file_count: 881,
    byte_count: 520_413,
    sha256: "3eb91a68ea309ddbf37558853506091a2ba1400c6e46ccd48028da097dcb855a"
  },
  generated_json_schema: {
    file_count: 440,
    byte_count: 4_340_196,
    sha256: "9b56f090022e5d9a02f9878cfd4d286f473935d45cb5d85ec6ebabfa12e24d46"
  }
});

export type CodexVersionCompatibility = {
  required_version: string;
  actual_version: string;
  compatible: boolean;
  override_used: boolean;
  raw: string;
};

export function parseCodexCliVersion(raw: string): string | null {
  const match = raw.match(/\bcodex-cli\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/i);
  return match?.[1] ?? null;
}

export function resolveCodexExecutable(requested: string | undefined, platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const command = (requested ?? "codex").trim() || "codex";
  // Only a bare `codex` command is a shim candidate. An explicit binary path
  // must remain authoritative, including when its basename is codex.exe.
  if (platform !== "win32" || /[\\/]/.test(command) || /^[A-Za-z]:/.test(command)
      || !/^codex(?:\.cmd|\.ps1|\.exe)?$/i.test(command)) return command;
  const appData = (env.APPDATA ?? "").trim();
  if (appData) {
    const candidates = [
      // npm may hoist the platform package beside @openai/codex.
      path.join(appData, "npm", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      path.join(appData, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
    ];
    for (const native of candidates) if (fs.existsSync(native)) return native;
  }
  return command;
}

function envEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export function evaluateCodexCliVersion(raw: string, env: NodeJS.ProcessEnv = process.env): CodexVersionCompatibility {
  const actualVersion = parseCodexCliVersion(raw);
  if (!actualVersion) throw new Error(`Could not parse Codex CLI version from: ${raw.trim() || "(empty output)"}`);
  const requiredVersion = (env.OPERATOR_CODEX_REQUIRED_VERSION ?? CODEX_APP_SERVER_COMPATIBILITY.codex_cli_version).trim();
  const compatible = actualVersion === requiredVersion;
  const overrideUsed = !compatible && envEnabled(env.OPERATOR_CODEX_ALLOW_UNPINNED);
  if (!compatible && !overrideUsed) {
    throw new Error(
      `Unsupported Codex CLI ${actualVersion}; Revit Operator is pinned to ${requiredVersion}. ` +
      `Install @openai/codex@${requiredVersion}, or set OPERATOR_CODEX_ALLOW_UNPINNED=1 only for an explicit compatibility test.`
    );
  }
  return { required_version: requiredVersion, actual_version: actualVersion, compatible, override_used: overrideUsed, raw: raw.trim() };
}
