import path from 'node:path';
import type {CodexThreadStartProfile} from '../brains/codex_turn_profile.js';
import {ensureCodexHomeAuth,ensureCodexHomeConfig,prepareCertifiedCodexIsolation} from './config.js';

export function getCodexProfilePaths(workspaceRoot: string, profile: CodexThreadStartProfile): { codexHome: string; cwd: string } {
  if (profile.certified) return prepareCertifiedCodexIsolation({ workspaceRoot });
  const codexHome = path.join(workspaceRoot, ".codex");
  ensureCodexHomeAuth({ codexHome });
  ensureCodexHomeConfig({ codexHome });
  return { codexHome, cwd: workspaceRoot };
}

export function buildCodexSpawnEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Use the selected Codex home's credentials; do not leak inherited API keys.
  delete env.OPENAI_API_KEY;
  delete env.OPERATOR_OPENAI_API_KEY;
  env.OPERATOR_WORKSPACE_ROOT = workspaceRoot;
  return env;
}
