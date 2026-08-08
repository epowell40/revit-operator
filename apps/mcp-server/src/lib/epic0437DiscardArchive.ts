import fs from "node:fs";
import path from "node:path";

export type Epic0437DiscardArchiveFacts = Readonly<{
  revitRunning: boolean;
  requestedRecoveryPath: string;
  recoveryRealPath: string;
  runsRootRealPath: string;
  recoveryIsRegularFile: boolean;
  recoveryIsRedirect: boolean;
  disposableModelPath: string;
  disposableModelRealPath: string;
  disposableRootRealPath: string;
  disposableHasRedirectComponent: boolean;
  disposableSha256: string;
  expectedPristineSha256: string;
  state: Readonly<Record<string, unknown>>;
}>;

function normalized(value: string): string {
  return path.win32.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

export function resolveTrustedWindowsTasklist(systemRoot: string | undefined): string {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("SystemRoot is unavailable; Revit process identity cannot be checked safely.");
  const requested = path.win32.join(systemRoot, "System32", "tasklist.exe");
  const real = fs.realpathSync.native(requested);
  const stat = fs.lstatSync(real);
  if (normalized(real) !== normalized(requested) || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("The exact trusted System32 tasklist executable could not be established.");
  }
  return real;
}

export function assertEpic0437DiscardArchiveFacts(facts: Epic0437DiscardArchiveFacts): void {
  if (facts.revitRunning) throw new Error("Revit.exe is still running. Close Revit without saving the disposable model before archiving recovery authority.");
  if (!facts.recoveryIsRegularFile || facts.recoveryIsRedirect
    || normalized(facts.requestedRecoveryPath) !== normalized(facts.recoveryRealPath)
    || normalized(path.dirname(facts.recoveryRealPath)) !== normalized(facts.runsRootRealPath)) {
    throw new Error("Recovery record escapes or redirects from the exact runs root.");
  }
  const relativeModel = path.win32.relative(facts.disposableRootRealPath, facts.disposableModelRealPath);
  if (normalized(facts.disposableModelPath) !== normalized(facts.disposableModelRealPath)
    || !normalized(facts.disposableModelRealPath).startsWith(`${normalized(facts.disposableRootRealPath)}\\`)
    || !/^[0-9a-f]{32}\\Snowdon Towers Sample HVAC\.rvt$/i.test(relativeModel)
    || facts.disposableHasRedirectComponent) {
    throw new Error("Discard archival requires the exact bounded, non-redirected Snowdon HVAC disposable-copy path.");
  }
  if (facts.disposableSha256 !== facts.expectedPristineSha256) {
    throw new Error("Discard archival requires an exact pristine installed-sample copy after Revit is closed.");
  }
  if (facts.state.schema !== "revit-operator.epic-0437-move-recovery.v2"
    || facts.state.state !== "host_restart_discard_required"
    || facts.state.retryable !== false || facts.state.outcome_unknown !== true
    || normalized(String(facts.state.disposable_model_path ?? "")) !== normalized(facts.disposableModelRealPath)
    || facts.state.disposable_model_sha256 !== facts.expectedPristineSha256) {
    throw new Error("Recovery record is not the exact non-promotable host-restart discard state for this pristine disposable copy.");
  }
}

/** Atomic no-clobber archive publication. If unlink fails, recovery stays live. */
export function publishEpic0437DiscardArchive(recoveryPath: string, archivePath: string): void {
  try {
    fs.linkSync(recoveryPath, archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Discard archive already exists; refusing to overwrite it.");
    throw error;
  }
  fs.unlinkSync(recoveryPath);
}
