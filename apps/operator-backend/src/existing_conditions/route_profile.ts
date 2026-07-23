export type RouteProfileShapeV1 = "round" | "rectangular" | "oval";

export type RouteProfileDimensionsV1 = {
  shape: RouteProfileShapeV1;
  diameter_ft: number | null;
  width_ft: number | null;
  height_ft: number | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function parseInches(value: unknown): number | null {
  const match = clean(value).match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:"|in|inch|inches)?$/i);
  if (!match) return null;
  const feet = Number(match[1]) / 12;
  return Number.isFinite(feet) && feet > 0 ? feet : null;
}

export function normalizeRouteProfileShapeV1(value: unknown): RouteProfileShapeV1 | null {
  const token = clean(value).toLowerCase();
  if (token === "round") return "round";
  if (token === "rectangular" || token === "rectangle" || token === "rect") return "rectangular";
  if (token === "oval") return "oval";
  return null;
}

export function parseRouteProfileSizeV1(shapeValue: unknown, sizeValue: unknown): RouteProfileDimensionsV1 | null {
  const shape = normalizeRouteProfileShapeV1(shapeValue);
  if (!shape) return null;
  if (shape === "round") {
    const diameter = parseInches(sizeValue);
    return diameter === null ? null : { shape, diameter_ft: diameter, width_ft: null, height_ft: null };
  }
  const parts = clean(sizeValue).replace(/×/g, "x").split(/\s*[xX]\s*/);
  if (parts.length !== 2) return null;
  const width = parseInches(parts[0]);
  const height = parseInches(parts[1]);
  if (width === null || height === null) return null;
  return { shape, diameter_ft: null, width_ft: width, height_ft: height };
}

function inches(feet: number): string {
  const value = Math.round(feet * 12 * 1e6) / 1e6;
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

export function formatRouteProfileSizeV1(profile: RouteProfileDimensionsV1): string {
  if (profile.shape === "round") return `${inches(profile.diameter_ft!)}"`;
  return `${inches(profile.width_ft!)}x${inches(profile.height_ft!)}`;
}

export function routeProfileDimensionsCompatibleV1(
  left: RouteProfileDimensionsV1,
  right: RouteProfileDimensionsV1,
  toleranceFt: number
): boolean {
  if (left.shape !== right.shape) return false;
  if (left.shape === "round") {
    return left.diameter_ft !== null && right.diameter_ft !== null &&
      Math.abs(left.diameter_ft - right.diameter_ft) <= toleranceFt;
  }
  return left.width_ft !== null && right.width_ft !== null &&
    left.height_ft !== null && right.height_ft !== null &&
    Math.abs(left.width_ft - right.width_ft) <= toleranceFt &&
    Math.abs(left.height_ft - right.height_ft) <= toleranceFt;
}
