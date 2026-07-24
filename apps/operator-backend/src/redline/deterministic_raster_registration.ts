import { createCanvas, loadImage } from "@napi-rs/canvas";

export type DeterministicRasterCrop = {
  min_u: number;
  min_v: number;
  max_u: number;
  max_v: number;
};

export type DeterministicRasterRegistration = {
  matched: boolean;
  confidence: number;
  crop: DeterministicRasterCrop | null;
  scale: number | null;
  translation_px: { x: number; y: number } | null;
  source_edge_support_ratio: number;
  edge_density_consistency: number;
  column_profile_correlation: number;
  row_profile_correlation: number;
  runner_up_score_margin: number | null;
  source_edge_sample_count: number;
  working_dimensions: {
    source_width_px: number;
    source_height_px: number;
    target_width_px: number;
    target_height_px: number;
    working_scale: number;
  };
};

type EdgeRaster = {
  width: number;
  height: number;
  edges: Uint8Array;
  orientations: Uint8Array;
  edge_integral: Uint32Array;
  edge_count: number;
  columns: Float64Array;
  rows: Float64Array;
  edge_points: Array<{ x: number; y: number; orientation: number }>;
};

type ProfileMatch = { offset: number; correlation: number };

type RasterCandidate = {
  scale: number;
  x: number;
  y: number;
  column_correlation: number;
  row_correlation: number;
  support: number;
  density_consistency: number;
  score: number;
};

const EDGE_THRESHOLD = 34;
const NEAR_EDGE_RADIUS_PX = 2;
const MAX_SOURCE_EDGE_SAMPLES = 6_000;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function imageDataUrlBytes(dataUrl: string): Buffer {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!match) throw new Error("deterministic_raster_registration_requires_base64_image_data_url");
  return Buffer.from(match[2]!, "base64");
}

async function renderEdgeRaster(
  dataUrl: string,
  workingScale: number
): Promise<EdgeRaster> {
  const image = await loadImage(imageDataUrlBytes(dataUrl));
  const width = Math.max(8, Math.round(image.width * workingScale));
  const height = Math.max(8, Math.round(image.height * workingScale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const luminance = new Uint8Array(width * height);
  for (let index = 0; index < luminance.length; index += 1) {
    const pixel = index * 4;
    luminance[index] = Math.round(
      0.2126 * pixels[pixel]! +
      0.7152 * pixels[pixel + 1]! +
      0.0722 * pixels[pixel + 2]!
    );
  }
  const edges = new Uint8Array(width * height);
  const orientations = new Uint8Array(width * height);
  const columns = new Float64Array(width);
  const rows = new Float64Array(height);
  const allEdgePoints: Array<{ x: number; y: number; orientation: number }> = [];
  for (let y = 1; y < height - 1; y += 1) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const index = rowOffset + x;
      const horizontal = Math.abs(luminance[index + 1]! - luminance[index - 1]!);
      const vertical = Math.abs(luminance[index + width]! - luminance[index - width]!);
      if (horizontal + vertical < EDGE_THRESHOLD) continue;
      const orientation =
        (horizontal >= EDGE_THRESHOLD / 2 ? 1 : 0) |
        (vertical >= EDGE_THRESHOLD / 2 ? 2 : 0);
      if (orientation === 0) continue;
      edges[index] = 1;
      orientations[index] = orientation;
      columns[x] += 1;
      rows[y] += 1;
      allEdgePoints.push({ x, y, orientation });
    }
  }
  const stride = Math.max(1, Math.ceil(allEdgePoints.length / MAX_SOURCE_EDGE_SAMPLES));
  const edgePoints = allEdgePoints.filter((_point, index) => index % stride === 0);
  const edgeIntegral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowTotal = 0;
    for (let x = 0; x < width; x += 1) {
      rowTotal += edges[y * width + x]!;
      edgeIntegral[(y + 1) * (width + 1) + x + 1] =
        edgeIntegral[y * (width + 1) + x + 1]! + rowTotal;
    }
  }
  return {
    width,
    height,
    edges,
    orientations,
    edge_integral: edgeIntegral,
    edge_count: allEdgePoints.length,
    columns,
    rows,
    edge_points: edgePoints
  };
}

function resampleProfile(profile: Float64Array, scale: number): Float64Array {
  const length = Math.max(3, Math.round(profile.length * scale));
  const output = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourceCoordinate = (index + 0.5) / scale - 0.5;
    const lower = Math.max(0, Math.min(profile.length - 1, Math.floor(sourceCoordinate)));
    const upper = Math.max(0, Math.min(profile.length - 1, lower + 1));
    const fraction = Math.max(0, Math.min(1, sourceCoordinate - lower));
    output[index] = profile[lower]! * (1 - fraction) + profile[upper]! * fraction;
  }
  return output;
}

function topProfileMatches(
  source: Float64Array,
  target: Float64Array,
  maximumMatches = 4
): ProfileMatch[] {
  if (source.length > target.length || source.length < 3) return [];
  const matches: ProfileMatch[] = [];
  for (let offset = 0; offset <= target.length - source.length; offset += 1) {
    const correlation = profileCorrelationAt(source, target, offset);
    if (finite(correlation)) matches.push({ offset, correlation });
  }
  matches.sort((left, right) => right.correlation - left.correlation);
  const separated: ProfileMatch[] = [];
  const minimumSeparation = Math.max(2, Math.round(source.length * 0.03));
  for (const match of matches) {
    if (separated.every((entry) => Math.abs(entry.offset - match.offset) >= minimumSeparation)) {
      separated.push(match);
    }
    if (separated.length >= maximumMatches) break;
  }
  return separated;
}

function profileCorrelationAt(
  source: Float64Array,
  target: Float64Array,
  offset: number
): number {
  if (
    source.length > target.length ||
    source.length < 3 ||
    offset < 0 ||
    offset + source.length > target.length
  ) return Number.NaN;
  let sourceSum = 0;
  let sourceSquares = 0;
  for (const value of source) {
    sourceSum += value;
    sourceSquares += value * value;
  }
  const sourceMean = sourceSum / source.length;
  const sourceVariance = sourceSquares - source.length * sourceMean * sourceMean;
  if (sourceVariance <= 1e-9) return Number.NaN;
  let targetSum = 0;
  let targetSquares = 0;
  for (let index = 0; index < source.length; index += 1) {
    const value = target[offset + index]!;
    targetSum += value;
    targetSquares += value * value;
  }
  const targetMean = targetSum / source.length;
  const targetVariance = targetSquares - source.length * targetMean * targetMean;
  if (targetVariance <= 1e-9) return Number.NaN;
  let numerator = 0;
  for (let index = 0; index < source.length; index += 1) {
    numerator += (source[index]! - sourceMean) *
      (target[offset + index]! - targetMean);
  }
  return numerator / Math.sqrt(sourceVariance * targetVariance);
}

function hasNearbyEdge(
  target: EdgeRaster,
  x: number,
  y: number,
  orientation: number,
  radius = NEAR_EDGE_RADIUS_PX
): boolean {
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  for (let dy = -radius; dy <= radius; dy += 1) {
    const targetY = centerY + dy;
    if (targetY < 0 || targetY >= target.height) continue;
    const rowOffset = targetY * target.width;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const targetX = centerX + dx;
      if (targetX < 0 || targetX >= target.width) continue;
      if ((target.orientations[rowOffset + targetX]! & orientation) !== 0) return true;
    }
  }
  return false;
}

function edgeSupport(
  source: EdgeRaster,
  target: EdgeRaster,
  scale: number,
  x: number,
  y: number
): number {
  if (source.edge_points.length === 0) return 0;
  let supported = 0;
  for (const point of source.edge_points) {
    if (hasNearbyEdge(
      target,
      x + point.x * scale,
      y + point.y * scale,
      point.orientation
    )) {
      supported += 1;
    }
  }
  return supported / source.edge_points.length;
}

function edgeCountInRect(
  raster: EdgeRaster,
  x: number,
  y: number,
  width: number,
  height: number
): number {
  const minX = Math.max(0, Math.min(raster.width, Math.floor(x)));
  const minY = Math.max(0, Math.min(raster.height, Math.floor(y)));
  const maxX = Math.max(minX, Math.min(raster.width, Math.ceil(x + width)));
  const maxY = Math.max(minY, Math.min(raster.height, Math.ceil(y + height)));
  const stride = raster.width + 1;
  return (
    raster.edge_integral[maxY * stride + maxX]! -
    raster.edge_integral[minY * stride + maxX]! -
    raster.edge_integral[maxY * stride + minX]! +
    raster.edge_integral[minY * stride + minX]!
  );
}

function edgeDensityConsistency(
  source: EdgeRaster,
  target: EdgeRaster,
  scale: number,
  x: number,
  y: number
): number {
  const expectedTargetEdgeCount = source.edge_count * scale;
  const actualTargetEdgeCount = edgeCountInRect(
    target,
    x,
    y,
    source.width * scale,
    source.height * scale
  );
  if (expectedTargetEdgeCount <= 0 || actualTargetEdgeCount <= 0) return 0;
  return Math.min(expectedTargetEdgeCount, actualTargetEdgeCount) /
    Math.max(expectedTargetEdgeCount, actualTargetEdgeCount);
}

function candidateScore(candidate: Omit<RasterCandidate, "score">): number {
  const profileScore =
    Math.max(0, candidate.column_correlation) * 0.02 +
    Math.max(0, candidate.row_correlation) * 0.02;
  return candidate.support * 0.55 +
    candidate.density_consistency * 0.41 +
    profileScore;
}

function evaluateCandidate(
  source: EdgeRaster,
  target: EdgeRaster,
  scale: number,
  x: number,
  y: number,
  columnCorrelation: number,
  rowCorrelation: number
): RasterCandidate {
  const candidateWithoutScore = {
    scale,
    x,
    y,
    column_correlation: columnCorrelation,
    row_correlation: rowCorrelation,
    support: edgeSupport(source, target, scale, x, y),
    density_consistency: edgeDensityConsistency(source, target, scale, x, y)
  };
  return {
    ...candidateWithoutScore,
    score: candidateScore(candidateWithoutScore)
  };
}

function bestCandidatesAtScale(
  source: EdgeRaster,
  target: EdgeRaster,
  scale: number
): RasterCandidate[] {
  const scaledColumns = resampleProfile(source.columns, scale);
  const scaledRows = resampleProfile(source.rows, scale);
  const rowMatches = topProfileMatches(scaledRows, target.rows, 12);
  const candidates: RasterCandidate[] = [];
  for (const row of rowMatches) {
    const localTargetColumns = columnProfileForBand(
      target,
      row.offset,
      scaledRows.length
    );
    const columnMatches = topProfileMatches(
      scaledColumns,
      localTargetColumns,
      12
    );
    for (const column of columnMatches) {
      candidates.push(evaluateCandidate(
        source,
        target,
        scale,
        column.offset,
        row.offset,
        column.correlation,
        row.correlation
      ));
    }
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 8);
}

function columnProfileForBand(
  raster: EdgeRaster,
  y: number,
  height: number
): Float64Array {
  const columns = new Float64Array(raster.width);
  const bandMinY = Math.max(0, Math.floor(y));
  const bandMaxY = Math.min(raster.height, Math.ceil(y + height));
  for (let targetY = bandMinY; targetY < bandMaxY; targetY += 1) {
    const rowOffset = targetY * raster.width;
    for (let x = 0; x < raster.width; x += 1) {
      columns[x] += raster.edges[rowOffset + x]!;
    }
  }
  return columns;
}

function uniqueCandidates(candidates: RasterCandidate[]): RasterCandidate[] {
  const sorted = candidates.slice().sort((left, right) => right.score - left.score);
  const unique: RasterCandidate[] = [];
  for (const candidate of sorted) {
    const duplicate = unique.some((entry) =>
      Math.abs(entry.scale - candidate.scale) < 0.01 &&
      Math.hypot(entry.x - candidate.x, entry.y - candidate.y) < 8
    );
    if (!duplicate) unique.push(candidate);
    if (unique.length >= 12) break;
  }
  return unique;
}

function refineCandidate(
  source: EdgeRaster,
  target: EdgeRaster,
  seed: RasterCandidate
): RasterCandidate {
  let best = seed;
  for (let scaleDelta = -0.012; scaleDelta <= 0.012 + 1e-9; scaleDelta += 0.003) {
    const scale = seed.scale + scaleDelta;
    if (scale <= 0) continue;
    const scaledWidth = source.width * scale;
    const scaledHeight = source.height * scale;
    for (let dy = -5; dy <= 5; dy += 1) {
      const y = seed.y + dy;
      if (y < 0 || y + scaledHeight > target.height) continue;
      for (let dx = -5; dx <= 5; dx += 1) {
        const x = seed.x + dx;
        if (x < 0 || x + scaledWidth > target.width) continue;
        const candidate = evaluateCandidate(
          source,
          target,
          scale,
          x,
          y,
          seed.column_correlation,
          seed.row_correlation
        );
        if (candidate.score > best.score) best = candidate;
      }
    }
  }
  return best;
}

export async function alignRasterCropDeterministically(args: {
  source_image_data_url: string;
  target_image_data_url: string;
  maximum_working_dimension?: number;
}): Promise<DeterministicRasterRegistration> {
  const sourceImage = await loadImage(imageDataUrlBytes(args.source_image_data_url));
  const targetImage = await loadImage(imageDataUrlBytes(args.target_image_data_url));
  const maximumDimension = Math.max(320, Math.min(1_200, Math.round(
    args.maximum_working_dimension ?? 900
  )));
  const workingScale = Math.min(
    1,
    maximumDimension /
      Math.max(sourceImage.width, sourceImage.height, targetImage.width, targetImage.height)
  );
  const [source, target] = await Promise.all([
    renderEdgeRaster(args.source_image_data_url, workingScale),
    renderEdgeRaster(args.target_image_data_url, workingScale)
  ]);
  const maximumScale = Math.min(
    2.5,
    target.width / source.width,
    target.height / source.height
  );
  const minimumScale = Math.min(maximumScale, 0.2);
  const coarseCandidates: RasterCandidate[] = [];
  for (let scale = minimumScale; scale <= maximumScale + 1e-9; scale += 0.02) {
    coarseCandidates.push(...bestCandidatesAtScale(source, target, scale));
  }
  const coarseBest = uniqueCandidates(coarseCandidates);
  const refined = uniqueCandidates(coarseBest.map((candidate) =>
    refineCandidate(source, target, candidate)
  ));
  const best = refined[0] ?? null;
  const runnerUp = refined[1] ?? null;
  const margin = best && runnerUp ? best.score - runnerUp.score : null;
  const matched = !!best &&
    best.support >= 0.65 &&
    best.density_consistency >= 0.8 &&
    best.column_correlation >= 0.1 &&
    best.row_correlation >= 0.2 &&
    (margin === null || margin >= 0.008);
  const crop = best
    ? {
        min_u: clamp01(best.x / target.width),
        min_v: clamp01(best.y / target.height),
        max_u: clamp01((best.x + source.width * best.scale) / target.width),
        max_v: clamp01((best.y + source.height * best.scale) / target.height)
      }
    : null;
  const confidence = best
    ? clamp01(
        best.support * 0.55 +
        best.density_consistency * 0.35 +
        Math.max(0, best.column_correlation) * 0.05 +
        Math.max(0, best.row_correlation) * 0.05
      )
    : 0;
  return {
    matched,
    confidence: rounded(confidence),
    crop: crop
      ? {
          min_u: rounded(crop.min_u),
          min_v: rounded(crop.min_v),
          max_u: rounded(crop.max_u),
          max_v: rounded(crop.max_v)
        }
      : null,
    scale: best ? rounded(best.scale / workingScale * workingScale) : null,
    translation_px: best
      ? {
          x: rounded(best.x / workingScale, 3),
          y: rounded(best.y / workingScale, 3)
        }
      : null,
    source_edge_support_ratio: rounded(best?.support ?? 0),
    edge_density_consistency: rounded(best?.density_consistency ?? 0),
    column_profile_correlation: rounded(best?.column_correlation ?? 0),
    row_profile_correlation: rounded(best?.row_correlation ?? 0),
    runner_up_score_margin: margin === null ? null : rounded(margin),
    source_edge_sample_count: source.edge_points.length,
    working_dimensions: {
      source_width_px: source.width,
      source_height_px: source.height,
      target_width_px: target.width,
      target_height_px: target.height,
      working_scale: rounded(workingScale)
    }
  };
}

export async function __testOnlyScoreRasterCrop(args: {
  source_image_data_url: string;
  target_image_data_url: string;
  crop: DeterministicRasterCrop;
  maximum_working_dimension?: number;
}): Promise<{
  scale_x: number;
  scale_y: number;
  source_edge_support_ratio: number;
  density_consistency: number;
  column_profile_correlation: number;
  row_profile_correlation: number;
  score: number;
}> {
  const sourceImage = await loadImage(imageDataUrlBytes(args.source_image_data_url));
  const targetImage = await loadImage(imageDataUrlBytes(args.target_image_data_url));
  const maximumDimension = Math.max(320, Math.min(1_200, Math.round(
    args.maximum_working_dimension ?? 900
  )));
  const workingScale = Math.min(
    1,
    maximumDimension /
      Math.max(sourceImage.width, sourceImage.height, targetImage.width, targetImage.height)
  );
  const [source, target] = await Promise.all([
    renderEdgeRaster(args.source_image_data_url, workingScale),
    renderEdgeRaster(args.target_image_data_url, workingScale)
  ]);
  const scaleX = (args.crop.max_u - args.crop.min_u) * target.width / source.width;
  const scaleY = (args.crop.max_v - args.crop.min_v) * target.height / source.height;
  const scale = Math.sqrt(scaleX * scaleY);
  const x = args.crop.min_u * target.width;
  const y = args.crop.min_v * target.height;
  const scaledColumns = resampleProfile(source.columns, scale);
  const scaledRows = resampleProfile(source.rows, scale);
  const roundedX = Math.max(
    0,
    Math.min(target.width - scaledColumns.length, Math.round(x))
  );
  const roundedY = Math.max(
    0,
    Math.min(target.height - scaledRows.length, Math.round(y))
  );
  const localTargetColumns = columnProfileForBand(
    target,
    roundedY,
    scaledRows.length
  );
  const columnCorrelation = profileCorrelationAt(
    scaledColumns,
    localTargetColumns,
    roundedX
  );
  const rowCorrelation = profileCorrelationAt(
    scaledRows,
    target.rows,
    roundedY
  );
  const support = edgeSupport(source, target, scale, x, y);
  const densityConsistency = edgeDensityConsistency(source, target, scale, x, y);
  const score = candidateScore({
    scale,
    x,
    y,
    column_correlation: columnCorrelation,
    row_correlation: rowCorrelation,
    support,
    density_consistency: densityConsistency
  });
  return {
    scale_x: rounded(scaleX),
    scale_y: rounded(scaleY),
    source_edge_support_ratio: rounded(support),
    density_consistency: rounded(densityConsistency),
    column_profile_correlation: rounded(columnCorrelation),
    row_profile_correlation: rounded(rowCorrelation),
    score: rounded(score)
  };
}
