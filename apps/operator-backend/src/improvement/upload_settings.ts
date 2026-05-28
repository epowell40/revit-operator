import { readCloudUploadConfig, type CloudUploadMode } from "../config/cloud_upload.js";

export type ImprovementUploadSettings = {
  mode: CloudUploadMode;
  upload_url: string;
  upload_token: string;
  gzip: boolean;
  interval_ms: number;
  max_per_tick: number;
  max_lines_per_file: number;
  timeout_ms: number;
  retry_backoff_ms: number;
};

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").toString().trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseIntEnv(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? "").toString().trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseMode(raw: string | undefined): CloudUploadMode | null {
  const v = (raw ?? "").toString().trim().toLowerCase();
  if (!v) return null;
  if (v === "off" || v === "once" || v === "watch") return v as CloudUploadMode;
  return null;
}

export function resolveImprovementUploadSettings(env: Record<string, string | undefined> = process.env): ImprovementUploadSettings {
  const cfg = readCloudUploadConfig() ?? {};

  const mode = parseMode(env.OPERATOR_IMPROVEMENT_UPLOAD_MODE) ?? (cfg.mode ?? "off");
  const upload_url = (env.OPERATOR_IMPROVEMENT_UPLOAD_URL ?? "").toString().trim() || (cfg.upload_url ?? "").trim();
  const upload_token = (env.OPERATOR_IMPROVEMENT_UPLOAD_TOKEN ?? "").toString().trim() || (cfg.upload_token ?? "").trim();

  const gzip = parseBool(env.OPERATOR_IMPROVEMENT_UPLOAD_GZIP, true);
  const interval_ms = parseIntEnv(env, "OPERATOR_IMPROVEMENT_UPLOAD_INTERVAL_MS", 60_000, 5_000, 10 * 60_000);
  const max_per_tick = parseIntEnv(env, "OPERATOR_IMPROVEMENT_UPLOAD_MAX_PER_TICK", 2, 1, 25);
  const max_lines_per_file = parseIntEnv(env, "OPERATOR_IMPROVEMENT_UPLOAD_MAX_LINES_PER_FILE", 4000, 200, 50_000);
  const timeout_ms = parseIntEnv(env, "OPERATOR_IMPROVEMENT_UPLOAD_TIMEOUT_MS", 30_000, 1_000, 5 * 60_000);
  const retry_backoff_ms = parseIntEnv(env, "OPERATOR_IMPROVEMENT_UPLOAD_RETRY_BACKOFF_MS", 5 * 60_000, 1_000, 24 * 60 * 60_000);

  return { mode, upload_url, upload_token, gzip, interval_ms, max_per_tick, max_lines_per_file, timeout_ms, retry_backoff_ms };
}

