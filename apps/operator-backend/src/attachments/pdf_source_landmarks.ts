type Operators = Record<string, number>;
type Circle = { x: number; y: number; radius: number };
type Candidate = { label: string; center: { u: number; v: number }; radius_u: number; radius_v: number };
type SourceInput = {
  operatorList: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> };
  textContent: { items: readonly unknown[]; styles?: Record<string, { ascent?: number; descent?: number }> };
  viewport: { transform: ArrayLike<number>; width: number; height: number };
  OPS: Operators;
};
const finiteArray = (value: unknown, count: number): value is ArrayLike<number> => {
  if (!value || typeof value !== "object") return false;
  const sequence = value as ArrayLike<unknown>;
  return sequence.length === count && Array.from(sequence).every(item => typeof item === "number" && Number.isFinite(item));
};
const transform = (m: ArrayLike<number>, p: readonly number[]) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const multiply = (a: ArrayLike<number>, b: ArrayLike<number>) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];

function circularPath(path: unknown, ops: Operators, matrix: number[]) {
  if (!Array.isArray(path)) return null;
  const [codes, values] = path;
  if (!finiteArray(codes, 6) || codes[0] !== ops.moveTo || codes[5] !== ops.closePath
      || !Array.from(codes).slice(1, 5).every(code => code === ops.curveTo) || !finiteArray(values, 26)) return null;
  const xs = Array.from(values).filter((_, i) => i % 2 === 0), ys = Array.from(values).filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const rx = (maxX-minX)/2, ry = (maxY-minY)/2, cx = (minX+maxX)/2, cy = (minY+maxY)/2;
  if (rx <= 0 || ry <= 0 || rx/ry < .95 || rx/ry > 1.05) return null;
  const distance = (x: number, y: number) => Math.hypot((x-cx)/rx, (y-cy)/ry);
  if (Math.hypot(values[24]-values[0], values[25]-values[1]) > .01*Math.min(rx, ry)) return null;
  for (let arc = 0; arc < 4; arc++) {
    const i = 2+arc*6;
    if (Math.abs(distance(values[i+4], values[i+5])-1) > .015) return null;
    for (const k of [0, 2]) if (distance(values[i+k], values[i+k+1]) < 1.11 || distance(values[i+k], values[i+k+1]) > 1.18) return null;
  }
  const xAxis = [matrix[0]*rx, matrix[1]*rx], yAxis = [matrix[2]*ry, matrix[3]*ry];
  const a = Math.hypot(...xAxis), b = Math.hypot(...yAxis);
  if (a <= 0 || b <= 0 || a/b < .95 || a/b > 1.05 || Math.abs(xAxis[0]*yAxis[0]+xAxis[1]*yAxis[1])/(a*b) > .02) return null;
  return { center: transform(matrix, [cx, cy]), radius: (a+b)/2 };
}

/** Untrusted PDF candidates only. A label does not establish model identity,
 * visible-layer membership, placement intent, engineering truth or permission. */
export function extractCircularLabelCandidates({ operatorList, textContent, viewport, OPS }: SourceInput) {
  const count = operatorList?.fnArray?.length;
  const omitted = (status: string) => ({ status, items: [] as Candidate[] });
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_500_000 || operatorList.argsArray?.length !== count
      || !finiteArray(viewport?.transform, 6) || ![viewport?.width, viewport?.height].every(x => Number.isFinite(x) && x > 0)) return omitted("omitted_for_source_budget");
  let matrix = [1, 0, 0, 1, 0, 0], annotationDepth = 0, omittedCount = 0;
  const stack: number[][] = [], circles: Circle[] = [];
  for (let i = 0; i < count; i++) {
    const op = operatorList.fnArray[i], args = operatorList.argsArray[i];
    if (op === OPS.save) { if (stack.length >= 256) return omitted("unsupported_graphics_state"); stack.push([...matrix]); }
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return omitted("unsupported_graphics_state"); matrix = stack.pop()!;
    } else if (op === OPS.transform) {
      if (!finiteArray(args, 6)) return omitted("unsupported_graphics_state"); matrix = multiply(matrix, args);
    } else if (op === OPS.paintFormXObjectBegin) {
      if (stack.length >= 256 || !Array.isArray(args)) return omitted("unsupported_graphics_state");
      stack.push([...matrix]);
      if (args[0]) { if (!finiteArray(args[0], 6)) return omitted("unsupported_graphics_state"); matrix = multiply(matrix, args[0]); }
    } else if (op === OPS.beginAnnotation) annotationDepth++;
    else if (op === OPS.endAnnotation) { if (!annotationDepth) return omitted("unsupported_graphics_state"); annotationDepth--; }
    else if (op === OPS.constructPath && !annotationDepth) {
      const candidate = circularPath(args, OPS, matrix); if (!candidate) continue;
      if (circles.length >= 2048) { omittedCount++; continue; }
      const c = transform(viewport.transform, candidate.center), r = candidate.radius*Math.hypot(viewport.transform[0], viewport.transform[1]);
      if (r < .5 || r > Math.min(viewport.width, viewport.height)*.04 || c[0]-r < 0 || c[1]-r < 0 || c[0]+r > viewport.width || c[1]+r > viewport.height) continue;
      if (!circles.some(old => Math.hypot(old.x-c[0], old.y-c[1]) < .02 && Math.abs(old.radius-r) < .02)) circles.push({ x: c[0], y: c[1], radius: r });
    }
  }
  if (stack.length || annotationDepth) return omitted("unsupported_graphics_state");
  const labels: Array<{ label: string; circle: Circle }> = [];
  for (const raw of (textContent?.items ?? []).slice(0, 50_000)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>, label = typeof item.str === "string" ? item.str.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,7}$/.test(label) || !finiteArray(item.transform, 6)
        || typeof item.width !== "number" || !Number.isFinite(item.width) || item.width <= 0 || typeof item.fontName !== "string") continue;
    const style = textContent.styles?.[item.fontName];
    if (!Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent)) continue;
    const t = item.transform, n = Math.hypot(t[0], t[1]); if (n <= 0) continue;
    const mid = (style!.ascent!+style!.descent!)/2;
    const center = transform(viewport.transform, [t[4]+t[0]/n*item.width/2+t[2]*mid, t[5]+t[1]/n*item.width/2+t[3]*mid]);
    const width = item.width*Math.hypot(viewport.transform[0], viewport.transform[1]);
    const matches = circles.filter(c => Math.hypot(c.x-center[0], c.y-center[1]) <= c.radius*.45 && width <= c.radius*2.15);
    if (matches.length === 1) labels.push({ label, circle: matches[0] });
  }
  const items: Candidate[] = []; let itemCharacters = 0;
  for (const circle of circles) {
    const matching = labels.filter(label => label.circle === circle); if (matching.length !== 1) continue;
    const item = { label: matching[0].label, center: { u: circle.x/viewport.width, v: circle.y/viewport.height }, radius_u: circle.radius/viewport.width, radius_v: circle.radius/viewport.height };
    const characters = JSON.stringify(item).length + 1;
    if (items.length >= 64 || itemCharacters + characters > 4500) { omittedCount++; continue; }
    items.push(item); itemCharacters += characters;
  }
  return { status: "source_candidates_only", source_content_only: true, visibility_not_established: true,
    note: "Source path and text candidates only. Clipping, occlusion and optional-layer visibility are not established. Visually confirm the selected view and labels; repeated labels do not identify model grids. Establish correspondence with fresh native landmarks before using coordinates.",
    coordinate_system: "full displayed page; normalized u right, v down; origin top left", candidate_count: items.length, omitted_candidate_count: omittedCount,
    partial_text_scan: textContent.items.length > 50_000,
    repeated_labels: [...new Set(items.filter((item, i) => items.some((other, j) => i !== j && other.label === item.label)).map(item => item.label))], items };
}
