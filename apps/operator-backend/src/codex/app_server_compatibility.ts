import fs from "node:fs";
import path from "node:path";

export const CODEX_APP_SERVER_COMPATIBILITY = Object.freeze({
  codex_cli_version: "0.144.5",
  protocol_mode: "experimental",
  generated_at: "2026-07-24",
  generated_typescript: {
    file_count: 671,
    byte_count: 377_094,
    sha256: "4e86cf1ec3eeec58473a432d06e316b725e13326700d55127478b9eb9ad30585"
  },
  generated_json_schema: {
    file_count: 337,
    byte_count: 3_159_797,
    sha256: "011a76cf38b60a616aa269376d38a5f166fa27eb83eb8905ba4e27b0776ccc9c"
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
    const native = path.join(appData, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    if (fs.existsSync(native)) return native;
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
