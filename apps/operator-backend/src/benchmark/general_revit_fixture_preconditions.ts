type JsonRecord = Record<string, unknown>;
import type { GeneralRevitCapabilityCase } from "./general_revit_capability_acceptance.js";
import path from "node:path";
import { sha256File } from "./protocol_v2_hash.js";

export function assertGeneralRevitFixtureBytes(fixtureRoot: string, filename: string, expectedSha256: string): void {
  const fixturePath = path.isAbsolute(filename) ? filename : path.join(fixtureRoot, filename);
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256) || sha256File(fixturePath) !== expectedSha256.toLowerCase()) {
    throw new Error(`Fixture bytes changed before case setup: ${fixturePath}. Stop the campaign; preserve evidence and restore the pristine fixture before a new run.`);
  }
}

export function validateGeneralRevitFixturePrecondition(testCase: GeneralRevitCapabilityCase): void {
  if (!testCase.fixture_precondition) return;
  const { active_view: activeView, selection, clear_selection: clearSelection } = testCase.fixture_precondition;
  if (clearSelection != null && typeof clearSelection !== "boolean") throw new Error(`Case ${testCase.case_id} has an invalid clear-selection fixture precondition.`);
  if (!activeView && !selection && clearSelection !== true) throw new Error(`Case ${testCase.case_id} has an empty fixture precondition.`);
  if (activeView && (!activeView.name.trim() || (activeView.view_type != null && !activeView.view_type.trim()))) throw new Error(`Case ${testCase.case_id} has an invalid active-view fixture precondition.`);
  if (selection && !selection.category.trim()) throw new Error(`Case ${testCase.case_id} has an invalid selection fixture precondition.`);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export function summarizeGeneralRevitFixturePreconditionCoverage(
  selectedCasesValue: unknown[],
  preparedReceiptsValue: unknown[]
): JsonRecord {
  const expectedCaseIds = selectedCasesValue
    .map(asRecord)
    .filter((entry) => Object.keys(asRecord(entry.fixture_precondition)).length > 0)
    .map((entry) => String(entry.case_id || "").trim())
    .filter(Boolean)
    .sort();
  const expected = new Set(expectedCaseIds);
  const successfulPreparedCaseIds = [...new Set(preparedReceiptsValue
    .map(asRecord)
    .filter((entry) => entry.ok === true
      && entry.schema === "revit-operator.general-revit-case-precondition/v1"
      && expected.has(String(entry.case_id || "").trim()))
    .map((entry) => String(entry.case_id || "").trim()))]
    .sort();
  const prepared = new Set(successfulPreparedCaseIds);
  const missingCaseIds = expectedCaseIds.filter((caseId) => !prepared.has(caseId));
  return {
    schema: "revit-operator.general-revit-fixture-precondition-coverage.v1",
    expected_case_count: expectedCaseIds.length,
    prepared_case_count: successfulPreparedCaseIds.length,
    expected_case_ids: expectedCaseIds,
    prepared_case_ids: successfulPreparedCaseIds,
    missing_case_ids: missingCaseIds,
    complete: missingCaseIds.length === 0
  };
}
