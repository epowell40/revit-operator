import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRedlineFile } from "../src/redline/redline_analyzer.js";
import { buildCommentedPdf } from "./fixtures/commented_pdf.js";

async function port() { const net = await import("node:net"); return await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const a = s.address() as any; s.close(() => resolve(a.port)); }); }); }
async function stop(child: ChildProcess) { if (child.exitCode === null) { child.kill(); await new Promise<void>((resolve) => child.once("exit", () => resolve())); } }
function stableLegacy(value: any) { const copy = structuredClone(value); delete copy.vision_artifacts; return copy; }
test("public redline analyze appends true-hash evidence without changing independent analyzer transport", async (t) => {
  const p = await port(), token = "redline-evidence-token", root = fs.mkdtempSync(path.join(os.tmpdir(), "redline-evidence-")), endpoint = `http://127.0.0.1:${p}/tools/redline/analyze`, relative = "artifacts/uploads/marked.pdf", file = path.join(root, "artifacts", "uploads", "marked.pdf"), previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buildCommentedPdf(1, new Map([[1, "12x10 SA duct 450 CFM"]])));
  process.env.OPERATOR_WORKSPACE_ROOT = root; const direct = await analyzeRedlineFile({ file_path: relative }); const directFailure = await analyzeRedlineFile({ file_path: "missing.pdf" }); if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], { env: { ...process.env, OPERATOR_BACKEND_PORT: String(p), OPERATOR_TOKEN: token, OPERATOR_WORKSPACE_ROOT: root, OPERATOR_MEMORY_AUTO_TURN_NOTES: "0" }, stdio: "ignore" }); t.after(async () => { await stop(child); fs.rmSync(root, { recursive: true, force: true }); });
  const headers = { "content-type": "application/json", "x-operator-token": token }; for (let i = 0; i < 100; i += 1) { try { await fetch(endpoint, { method: "POST", headers, body: "{}" }); break; } catch { await new Promise((r) => setTimeout(r, 25)); } }
  const unauthenticated = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_path: relative }) }); assert.equal(unauthenticated.status, 401);
  const ok = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ file_path: relative, provider: { name: "request-spoof" } }) }); assert.equal(ok.status, 200); const response: any = await ok.json(); const { aec_intent_evidence, ...legacy } = response;
  assert.deepEqual(stableLegacy(legacy), stableLegacy(direct)); assert.equal(aec_intent_evidence.origin.provider, undefined); assert.equal(aec_intent_evidence.target.status, "ambiguous"); assert.equal(aec_intent_evidence.evidence[0].sha256, createHash("sha256").update(fs.readFileSync(file)).digest("hex")); assert.equal(JSON.stringify(aec_intent_evidence).includes(root), false);
  const bad = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ file_path: "missing.pdf" }) }); assert.equal(bad.status, 400); const badBody: any = await bad.json(); assert.deepEqual(badBody, directFailure); assert.equal((badBody as any).aec_intent_evidence, undefined);
});
