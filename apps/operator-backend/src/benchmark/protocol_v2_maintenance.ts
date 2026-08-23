export type BenchmarkRepairCohortV2 = {
  repair_id: string;
  original_case_id: string;
  neighboring_case_ids: string[];
  negative_case_id: string;
  unrelated_regression_case_id: string;
};

export function validateBenchmarkRepairCohortV2(value: BenchmarkRepairCohortV2): void {
  if (!value.repair_id.trim() || !value.original_case_id.trim()) throw new Error("A visible-case repair must identify itself and its original case.");
  const neighbors = [...new Set(value.neighboring_case_ids.map((entry) => entry.trim()).filter(Boolean))];
  if (neighbors.length < 3) throw new Error("A visible-case repair requires at least three meaningful neighboring perturbations.");
  if (!value.negative_case_id.trim()) throw new Error("A visible-case repair requires a negative case that must not pass.");
  if (!value.unrelated_regression_case_id.trim()) throw new Error("A visible-case repair requires an unrelated regression case.");
  const roles = [value.original_case_id, ...neighbors, value.negative_case_id, value.unrelated_regression_case_id];
  if (new Set(roles).size !== roles.length) throw new Error("Repair cohort roles must be distinct cases.");
}
