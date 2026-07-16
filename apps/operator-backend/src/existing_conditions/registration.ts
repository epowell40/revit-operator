export type ExistingConditionsPlanPoint = {
  x: number;
  y: number;
};

export type ExistingConditionsRegistrationControlPoint = {
  source: ExistingConditionsPlanPoint;
  model: ExistingConditionsPlanPoint;
};

export type ExistingConditionsRegistrationInput = {
  source_evidence_sha256: string;
  control_points: ExistingConditionsRegistrationControlPoint[];
  /** Permit a handedness flip, as required when top-left raster Y maps to increasing plan north. */
  allow_reflection?: boolean;
  max_rms_error_ft?: number;
  max_point_error_ft?: number;
};

export type ExistingConditionsRegistrationReceipt = {
  schema_version: 1;
  source_evidence_sha256: string;
  control_point_count: number;
  scale: number;
  rotation_degrees: number;
  reflection_applied?: boolean;
  translation_ft: ExistingConditionsPlanPoint;
  rms_error_ft: number;
  maximum_error_ft: number;
  max_rms_error_ft: number;
  max_point_error_ft: number;
  verified: boolean;
};

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function point(value: ExistingConditionsPlanPoint, label: string): ExistingConditionsPlanPoint {
  if (!value || typeof value !== "object") throw new Error(`${label}_is_required`);
  return {
    x: finite(value.x, `${label}_x`),
    y: finite(value.y, `${label}_y`)
  };
}

function sha256(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("source_evidence_sha256_must_be_sha256");
  return normalized;
}

export function solveExistingConditionsRegistration(
  input: ExistingConditionsRegistrationInput
): ExistingConditionsRegistrationReceipt {
  const sourceEvidenceSha256 = sha256(input.source_evidence_sha256);
  if (!Array.isArray(input.control_points) || input.control_points.length < 3) {
    throw new Error("registration_requires_at_least_three_control_points");
  }
  const controls = input.control_points.map((entry, index) => ({
    source: point(entry.source, `control_point_${index}_source`),
    model: point(entry.model, `control_point_${index}_model`)
  }));
  const maxRmsErrorFt = input.max_rms_error_ft == null
    ? 0.25
    : finite(input.max_rms_error_ft, "max_rms_error_ft");
  if (maxRmsErrorFt < 0) throw new Error("max_rms_error_ft_must_be_nonnegative");
  const maxPointErrorFt = input.max_point_error_ft == null
    ? maxRmsErrorFt
    : finite(input.max_point_error_ft, "max_point_error_ft");
  if (maxPointErrorFt < 0) throw new Error("max_point_error_ft_must_be_nonnegative");

  const origin = controls[0]!.source;
  const nonCollinear = controls.slice(1).some((first, firstIndex) => controls.slice(firstIndex + 2).some((second) => {
    const ax = first.source.x - origin.x;
    const ay = first.source.y - origin.y;
    const bx = second.source.x - origin.x;
    const by = second.source.y - origin.y;
    return Math.abs(ax * by - ay * bx) > 1e-9;
  }));
  if (!nonCollinear) throw new Error("registration_source_control_points_must_be_non_collinear");

  const sourceCentroid = controls.reduce(
    (sum, entry) => ({ x: sum.x + entry.source.x, y: sum.y + entry.source.y }),
    { x: 0, y: 0 }
  );
  const modelCentroid = controls.reduce(
    (sum, entry) => ({ x: sum.x + entry.model.x, y: sum.y + entry.model.y }),
    { x: 0, y: 0 }
  );
  sourceCentroid.x /= controls.length;
  sourceCentroid.y /= controls.length;
  modelCentroid.x /= controls.length;
  modelCentroid.y /= controls.length;

  let denominator = 0;
  let properA = 0;
  let properB = 0;
  let reflectedA = 0;
  let reflectedB = 0;
  for (const entry of controls) {
    const sx = entry.source.x - sourceCentroid.x;
    const sy = entry.source.y - sourceCentroid.y;
    const mx = entry.model.x - modelCentroid.x;
    const my = entry.model.y - modelCentroid.y;
    denominator += sx * sx + sy * sy;
    properA += sx * mx + sy * my;
    properB += sx * my - sy * mx;
    reflectedA += sx * mx - sy * my;
    reflectedB += sy * mx + sx * my;
  }
  if (denominator <= 1e-12) throw new Error("registration_source_control_points_are_degenerate");

  type Candidate = {
    a: number;
    b: number;
    reflected: boolean;
    translation: ExistingConditionsPlanPoint;
    squared_error: number;
    maximum_error_ft: number;
  };
  const buildCandidate = (a: number, b: number, reflected: boolean): Candidate => {
    const translation = reflected
      ? {
          x: modelCentroid.x - (a * sourceCentroid.x + b * sourceCentroid.y),
          y: modelCentroid.y - (b * sourceCentroid.x - a * sourceCentroid.y)
        }
      : {
          x: modelCentroid.x - (a * sourceCentroid.x - b * sourceCentroid.y),
          y: modelCentroid.y - (b * sourceCentroid.x + a * sourceCentroid.y)
        };
    let squaredError = 0;
    let maximumErrorFt = 0;
    for (const entry of controls) {
      const transformed = reflected
        ? {
            x: a * entry.source.x + b * entry.source.y + translation.x,
            y: b * entry.source.x - a * entry.source.y + translation.y
          }
        : {
            x: a * entry.source.x - b * entry.source.y + translation.x,
            y: b * entry.source.x + a * entry.source.y + translation.y
          };
      const error = Math.hypot(transformed.x - entry.model.x, transformed.y - entry.model.y);
      squaredError += error * error;
      maximumErrorFt = Math.max(maximumErrorFt, error);
    }
    return { a, b, reflected, translation, squared_error: squaredError, maximum_error_ft: maximumErrorFt };
  };
  const candidates = [buildCandidate(properA / denominator, properB / denominator, false)];
  if (input.allow_reflection === true) {
    candidates.push(buildCandidate(reflectedA / denominator, reflectedB / denominator, true));
  }
  const selected = candidates.reduce((best, candidate) =>
    candidate.squared_error < best.squared_error ? candidate : best
  );
  const { a, b } = selected;
  const scale = Math.hypot(a, b);
  if (!Number.isFinite(scale) || scale <= 1e-12) throw new Error("registration_scale_is_degenerate");
  const rmsErrorFt = Math.sqrt(selected.squared_error / controls.length);

  return {
    schema_version: 1,
    source_evidence_sha256: sourceEvidenceSha256,
    control_point_count: controls.length,
    scale,
    rotation_degrees: Math.atan2(b, a) * 180 / Math.PI,
    reflection_applied: selected.reflected,
    translation_ft: selected.translation,
    rms_error_ft: rmsErrorFt,
    maximum_error_ft: selected.maximum_error_ft,
    max_rms_error_ft: maxRmsErrorFt,
    max_point_error_ft: maxPointErrorFt,
    verified: rmsErrorFt <= maxRmsErrorFt && selected.maximum_error_ft <= maxPointErrorFt
  };
}

export function transformExistingConditionsPlanPoint(
  receipt: ExistingConditionsRegistrationReceipt,
  source: ExistingConditionsPlanPoint
): ExistingConditionsPlanPoint {
  const value = point(source, "source_point");
  const radians = receipt.rotation_degrees * Math.PI / 180;
  const a = receipt.scale * Math.cos(radians);
  const b = receipt.scale * Math.sin(radians);
  return receipt.reflection_applied === true
    ? {
        x: a * value.x + b * value.y + receipt.translation_ft.x,
        y: b * value.x - a * value.y + receipt.translation_ft.y
      }
    : {
        x: a * value.x - b * value.y + receipt.translation_ft.x,
        y: b * value.x + a * value.y + receipt.translation_ft.y
      };
}
