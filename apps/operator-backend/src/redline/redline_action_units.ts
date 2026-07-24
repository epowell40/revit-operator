import type { RedlineAnalyzeResponse } from "./redline_analyzer.js";
import {
  classifyRedlineCorpusText,
  type RedlineCorpusClassification,
  type RedlineOperationClass
} from "./corpus_classifier.js";

export type RedlineActionUnit = {
  unit_index: number;
  page: number | null;
  region_indices: number[];
  annotation_indices: number[];
  grouping_basis: "explicit_relation" | "proximity" | "single_region";
  text: string;
  mutability: "unknown" | "revit_write";
  classification: RedlineCorpusClassification;
  candidate_operations: RedlineOperationClass[];
  manual_review_reason?: string;
};

type Region = NonNullable<RedlineAnalyzeResponse["mark_regions"]>[number];

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function regionText(region: Region): string {
  return unique([region.annotation_contents, region.annotation_related_text]
    .map((value) => (value ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)).join(" ");
}

function hasExplicitRelation(regions: Region[], groupReason: string): boolean {
  const annotationIndices = new Set(regions.map((region) => region.annotation_index).filter((value): value is number => typeof value === "number"));
  const hasCrossReferencedAnnotations = regions.some((region) =>
    (region.annotation_related_indices ?? []).some((index) => annotationIndices.has(index))
  );
  if (hasCrossReferencedAnnotations) return true;
  const reason = groupReason.trim().toLowerCase();
  return /\b(explicit|related|linked|same[_ -]?annotation)\b/.test(reason) && !/\b(nearby|proximity|distance)\b/.test(reason);
}

function classifyFragments(filePath: string, regions: Region[]): RedlineCorpusClassification[] {
  return regions
    .map(regionText)
    .filter(Boolean)
    .map((text) => classifyRedlineCorpusText({ file_path: filePath, text }));
}

export function buildRedlineActionUnits(analysis: RedlineAnalyzeResponse): RedlineActionUnit[] {
  const regions = Array.isArray(analysis.mark_regions) ? analysis.mark_regions : [];
  if (regions.length === 0) return [];
  const byIndex = new Map(regions.map((region) => [region.index, region]));
  const claimed = new Set<number>();
  const rawUnits: Array<{ regions: Region[]; basis: RedlineActionUnit["grouping_basis"] }> = [];

  for (const group of analysis.annotation_groups ?? []) {
    const grouped = unique(group.region_indices)
      .map((index) => byIndex.get(index))
      .filter((region): region is Region => !!region && !claimed.has(region.index));
    if (grouped.length === 0) continue;
    grouped.forEach((region) => claimed.add(region.index));
    rawUnits.push({ regions: grouped, basis: hasExplicitRelation(grouped, group.reason) ? "explicit_relation" : "proximity" });
  }

  for (const region of regions) {
    if (claimed.has(region.index)) continue;
    rawUnits.push({ regions: [region], basis: "single_region" });
  }

  const units: RedlineActionUnit[] = [];
  for (const raw of rawUnits) {
    const pages = unique(raw.regions.map((region) => region.annotation_page ?? null));
    for (const page of pages) {
      const pageRegions = raw.regions.filter((region) => (region.annotation_page ?? null) === page);
      const text = unique(pageRegions.map(regionText).filter(Boolean)).join(" ");
      const classification = classifyRedlineCorpusText({ file_path: analysis.file_path, text });
      const fragments = raw.basis === "proximity" ? classifyFragments(analysis.file_path, pageRegions) : [];
      const candidateOperations = unique(
        [classification, ...fragments]
          .map((item) => item.operation_class)
          .filter((operation) => operation !== "unknown")
      );
      const mixedIntent = raw.basis === "proximity" && candidateOperations.length > 1;
      units.push({
        unit_index: units.length + 1,
        page,
        region_indices: pageRegions.map((region) => region.index),
        annotation_indices: unique(pageRegions.map((region) => region.annotation_index).filter((value): value is number => typeof value === "number")),
        grouping_basis: raw.basis,
        text,
        mutability: classification.operation_class === "unknown" ? "unknown" : "revit_write",
        classification,
        candidate_operations: candidateOperations,
        ...(mixedIntent ? { manual_review_reason: "multiple_operation_intents_in_proximity_group" } : {})
      });
    }
  }

  return units;
}
