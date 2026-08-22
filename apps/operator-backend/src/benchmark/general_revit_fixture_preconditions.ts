type JsonRecord = Record<string, unknown>;

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
