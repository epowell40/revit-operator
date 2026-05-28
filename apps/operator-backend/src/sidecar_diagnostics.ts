import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getDesktopComputerConfig } from "./desktop_computer.js";
import { ensureWorkspaceLayout } from "./workspace.js";

function trim(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= max ? text : `${text.slice(0, max).trim()}...`;
}

function exists(filePath: string): boolean {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function canWrite(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.operator_probe_${process.pid}_${Date.now()}.tmp`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function canBindLocalPort(port: number): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: any) => resolve({ ok: false, error: trim(err?.message || String(err)) }));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve({ ok: true }));
    });
  });
}

async function fetchHealth(url: string): Promise<Record<string, unknown>> {
  if (!url) return { ok: false, error: "No health URL configured." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let payload: unknown = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text.slice(0, 1000); }
    return { ok: res.ok, status: res.status, payload };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function readLastLines(filePath: string, maxLines = 60): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/g).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

export async function buildSidecarDiagnosticReport(): Promise<Record<string, unknown>> {
  const ws = ensureWorkspaceLayout();
  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const installPath = trim(process.env.OPERATOR_SIDECAR_INSTALL_PATH) || path.join(appData, "RevitOperator", "sidecar");
  const sidecarPort = Number.parseInt(process.env.OPERATOR_SIDECAR_PORT || process.env.OPERATOR_DESKTOP_SIDECAR_PORT || "5010", 10) || 5010;
  const healthUrl = trim(process.env.OPERATOR_SIDECAR_HEALTH_URL) || `http://127.0.0.1:${sidecarPort}/health`;
  const logCandidates = [
    path.join(ws.logs, "sidecar.log"),
    path.join(appData, "RevitOperator", "Logs", "sidecar.log"),
    path.join(installPath, "logs", "sidecar.log")
  ];
  const bind = await canBindLocalPort(sidecarPort);
  const health = await fetchHealth(healthUrl);
  const desktopConfig = getDesktopComputerConfig();
  const processInfo = {
    pid: process.pid,
    node: process.version,
    elevation_hint: process.platform === "win32" ? "Run `whoami /groups` or Process Explorer for definitive elevation state." : "not_windows",
    uid: typeof process.getuid === "function" ? process.getuid() : null
  };

  return {
    version: "operator.sidecar_diagnostics.v1",
    generated_at: new Date().toISOString(),
    os: {
      platform: process.platform,
      release: os.release(),
      version: typeof os.version === "function" ? os.version() : null,
      arch: os.arch(),
      hostname: os.hostname(),
      username: os.userInfo().username
    },
    process: processInfo,
    paths: {
      install_path: installPath,
      install_path_exists: exists(installPath),
      workspace_root: ws.root,
      logs_path: ws.logs,
      config_path: path.join(appData, "RevitOperator", "config"),
      write_permissions: {
        install_path: canWrite(installPath),
        workspace_logs: canWrite(ws.logs),
        appdata_config: canWrite(path.join(appData, "RevitOperator", "config"))
      }
    },
    sidecar: {
      configured_health_url: healthUrl,
      expected_port: sidecarPort,
      port_bind_available: bind.ok,
      port_bind_error: bind.error ?? null,
      health,
      desktop_computer_backend: desktopConfig,
      version: typeof (health as any)?.payload?.version === "string" ? (health as any).payload.version : null,
      reachable: !!health.ok,
      hints: [
        bind.ok ? "Port is free; if sidecar should be running, it likely did not start." : "Port is occupied or blocked; compare the owning process and elevation.",
        health.ok ? "Health endpoint responded." : "Health endpoint did not respond; check endpoint protection, firewall localhost policy, install path, and runtime logs.",
        desktopConfig.available ? "Backend computer-use relay has API credentials." : "Backend computer-use relay lacks API credentials; native Revit tools should still work."
      ]
    },
    runtimes: {
      node: process.version,
      dotnet_hint: "Use `dotnet --info` on the workstation if the sidecar depends on .NET.",
      python_hint: "Use `py --version` or `python --version` if the sidecar depends on Python.",
      webview2_hint: "Native add-in reports WebView2 availability in /revit/native-capabilities when Revit is running."
    },
    logs: logCandidates.map((candidate) => ({
      path: candidate,
      exists: exists(candidate),
      last_lines: readLastLines(candidate)
    }))
  };
}
