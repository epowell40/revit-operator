import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertEpic0437DiscardArchiveFacts, publishEpic0437DiscardArchive, resolveTrustedWindowsTasklist } from "../lib/epic0437DiscardArchive.js";

const PRISTINE_SNOWDON_HVAC_SHA256 = "sha256:585385991b1f8a168881c4bc36546bc90e7bfb427c263d801fe367fa2ebb0fa8";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function digest(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function normalizedWindowsPath(value: string): string {
  return path.win32.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function requireRevitClosed(): void {
  const tasklistReal = resolveTrustedWindowsTasklist(process.env.SystemRoot);
  const listing = execFileSync(tasklistReal, ["/FI", "IMAGENAME eq Revit.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (/"Revit\.exe"/i.test(listing)) throw new Error("Revit.exe is still running. Close Revit without saving the disposable model before archiving recovery authority.");
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const recoveryName = argument("--recovery-file");
  const disposableArgument = argument("--disposable-model-path");
  if (!recoveryName || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.recovery\.json$/.test(recoveryName)) {
    throw new Error("--recovery-file must be one direct EPIC-0437 runs-root *.recovery.json filename.");
  }
  if (!disposableArgument || !path.win32.isAbsolute(disposableArgument)) {
    throw new Error("--disposable-model-path must be the exact absolute disposable RVT path.");
  }

  requireRevitClosed();
  const disposableRoot = path.join(process.env.LOCALAPPDATA ?? "", "RevitOperator", "CertificationEvidence", "DisposableModels");
  const rootReal = fs.realpathSync.native(disposableRoot);
  const modelReal = fs.realpathSync.native(path.resolve(disposableArgument));
  const relativeModel = path.win32.relative(rootReal, modelReal);
  if (!normalizedWindowsPath(modelReal).startsWith(`${normalizedWindowsPath(rootReal)}\\`)
    || !/^[0-9a-f]{32}\\Snowdon Towers Sample HVAC\.rvt$/i.test(relativeModel)) {
    throw new Error("Discard archival requires the exact bounded Snowdon HVAC disposable-copy path.");
  }
  let inspected = rootReal;
  for (const component of relativeModel.split(path.win32.sep)) {
    inspected = path.join(inspected, component);
    if (fs.lstatSync(inspected).isSymbolicLink()) throw new Error("Discard archival refuses a redirected disposable path.");
  }
  const disposableHasRedirectComponent = (() => {
    let current = rootReal;
    for (const component of relativeModel.split(path.win32.sep)) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    }
    return false;
  })();

  const runsRoot = path.join(repoRoot, "artifacts", "certification", "epic-0437", "runs");
  const recoveryPath = path.join(runsRoot, recoveryName);
  const requestedRecovery = path.resolve(recoveryPath);
  const requestedStat = fs.lstatSync(requestedRecovery);
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) throw new Error("Recovery record must be one regular non-redirected file.");
  const recoveryReal = fs.realpathSync.native(recoveryPath);
  const state = JSON.parse(fs.readFileSync(recoveryReal, "utf8")) as Record<string, unknown>;
  assertEpic0437DiscardArchiveFacts({
    revitRunning: false,
    requestedRecoveryPath: requestedRecovery, recoveryRealPath: recoveryReal,
    runsRootRealPath: fs.realpathSync.native(runsRoot), recoveryIsRegularFile: requestedStat.isFile(),
    recoveryIsRedirect: requestedStat.isSymbolicLink(), disposableModelPath: path.resolve(disposableArgument),
    disposableModelRealPath: modelReal, disposableRootRealPath: rootReal, disposableHasRedirectComponent,
    disposableSha256: digest(modelReal), expectedPristineSha256: PRISTINE_SNOWDON_HVAC_SHA256, state
  });

  const archivePath = recoveryPath.replace(/\.recovery\.json$/, ".discarded.json");
  // linkSync is an atomic no-clobber publication on the same volume. If the
  // subsequent unlink is interrupted, the original recovery record remains
  // discoverable and blocks another evidence run; no unsafe partial success is
  // possible.
  publishEpic0437DiscardArchive(recoveryReal, archivePath);
  process.stdout.write(`${JSON.stringify({ archived: path.basename(archivePath), model_sha256: PRISTINE_SNOWDON_HVAC_SHA256 }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
