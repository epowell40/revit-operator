type Coverage = { ratio: number; total_length_ft: number };
export function routeCoverageMetrics(recallCoverage: Coverage | null, precisionCoverage: Coverage | null) {
  if (!recallCoverage || !precisionCoverage) return { recall: null, precision: null, f1: null };
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  // Overlapping duplicate traces consume additional length even when all their
  // samples lie on the source. Preserve the capacity bound across segmentation.
  const recall = Math.min(recallCoverage.ratio, clamp(precisionCoverage.total_length_ft / recallCoverage.total_length_ft));
  const precision = Math.min(precisionCoverage.ratio, clamp(recallCoverage.total_length_ft / Math.max(precisionCoverage.total_length_ft, Number.EPSILON)));
  return { recall, precision, f1: precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0 };
}
