import fs from "node:fs";
import path from "node:path";

export const CODEX_APP_SERVER_COMPATIBILITY = Object.freeze({
  codex_cli_version: "0.149.0",
  protocol_mode: "experimental",
  generated_at: "2026-08-21",
  generated_typescript: {
    file_count: 781,
    byte_count: 454_645,
    sha256: "2c6938681ea2f9d521987335d3bfc84f5c0c72d1b5596636db3d40f727f54182"
  },
  generated_json_schema: {
    file_count: 401,
    byte_count: 3_778_968,
    sha256: "b0560d8c302423145d4f203ef49b6c5eea5ddc6e1b8a8ec7b794c496698def5c"
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
  if (platform !== "win32" || !/^codex(?:\.cmd|\.ps1|\.exe)?$/i.test(path.basename(command))) return command;
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
