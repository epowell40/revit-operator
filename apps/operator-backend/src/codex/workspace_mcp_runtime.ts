import path from 'node:path';
import {CodexMcpToolRuntime} from './mcp_tool_runtime.js';
import {buildCodexSpawnEnv} from './profile_environment.js';

// One tool-runtime pool for both execution frontends and cancellation. This
// contains no model process; a desktop owner must not start a helper to use it.
export const workspaceMcpRuntimes = new Map<string,CodexMcpToolRuntime>();
// Tool-transport exclusion, not task state. A helper cannot begin while the
// desktop owner is dispatching through this same runtime (and vice versa).
export const desktopNativeCallsByWorkspace = new Set<string>();

/** Construct runtime ownership before provider setup. A cold tenant cannot
 * depend on prewarming another workspace or on a later CLI call. The caller
 * retains the cache used by cancellation; construction starts no process. */
export function getWorkspaceMcpRuntime(
  runtimes: Map<string,CodexMcpToolRuntime>,
  workspaceRoot: string,
  codexHome = path.join(workspaceRoot,'.codex')
): CodexMcpToolRuntime {
  let runtime = runtimes.get(workspaceRoot);
  if (!runtime) {
    runtime = new CodexMcpToolRuntime({
      backendCwd: process.cwd(), workspaceRoot, codexHome,
      spawnEnv: buildCodexSpawnEnv(workspaceRoot)
    });
    runtimes.set(workspaceRoot,runtime);
  }
  return runtime;
}
