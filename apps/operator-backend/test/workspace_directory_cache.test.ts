import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __testOnlyResetWorkspaceDirectoryCache, ensureWorkspaceLayout } from "../src/workspace.js";

test("workspace layout avoids repeated synchronous directory probes within the bounded cache window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-workspace-cache-"));
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const originalMkdirSync = fs.mkdirSync;
  let mkdirCalls = 0;
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    __testOnlyResetWorkspaceDirectoryCache();
    fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      mkdirCalls += 1;
      return originalMkdirSync(...args as [fs.PathLike, fs.MakeDirectoryOptions & { recursive: true }]);
    }) as typeof fs.mkdirSync;

    ensureWorkspaceLayout();
    assert.ok(mkdirCalls >= 10);
    mkdirCalls = 0;
    ensureWorkspaceLayout();
    assert.equal(mkdirCalls, 0);

    __testOnlyResetWorkspaceDirectoryCache();
    ensureWorkspaceLayout();
    assert.ok(mkdirCalls >= 10);
  } finally {
    fs.mkdirSync = originalMkdirSync;
    __testOnlyResetWorkspaceDirectoryCache();
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
