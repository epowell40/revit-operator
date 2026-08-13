import path from "node:path";
import { benchmarkDataRoot, readJsonFile } from "./files.js";
import type { GeneralRevitCapabilityCase } from "./general_revit_capability_acceptance.js";

export const GENERAL_REVIT_SAMPLE_FIXTURES_SCHEMA = "revit-operator.general-revit-sample-fixtures/v1" as const;

export type GeneralRevitSampleFixture = {
  discipline: string;
  document_title: string;
  sample_filename: string;
};

export type GeneralRevitSampleFixtures = {
  schema: typeof GENERAL_REVIT_SAMPLE_FIXTURES_SCHEMA;
  default_fixture: string;
  fixtures: Record<string, GeneralRevitSampleFixture>;
  case_overrides: Record<string, string[]>;
};

export function loadGeneralRevitSampleFixtures(cases: GeneralRevitCapabilityCase[]): GeneralRevitSampleFixtures {
  const config = readJsonFile<GeneralRevitSampleFixtures>(
    path.join(benchmarkDataRoot(), "general-agent", "sample-fixtures.v1.json")
  );
  if (config.schema !== GENERAL_REVIT_SAMPLE_FIXTURES_SCHEMA) throw new Error("Unexpected General Revit sample-fixture schema.");
  if (!config.fixtures[config.default_fixture]) throw new Error("General Revit default sample fixture is undefined.");
  const knownCases = new Set(cases.map((entry) => entry.case_id));
  const assigned = new Set<string>();
  for (const [fixtureKey, caseIds] of Object.entries(config.case_overrides)) {
    if (!config.fixtures[fixtureKey]) throw new Error(`Unknown General Revit sample fixture ${fixtureKey}.`);
    for (const caseId of caseIds) {
      if (!knownCases.has(caseId)) throw new Error(`${fixtureKey}: unknown General Revit case ${caseId}.`);
      if (assigned.has(caseId)) throw new Error(`${caseId}: sample fixture is assigned more than once.`);
      assigned.add(caseId);
    }
  }
  for (const [fixtureKey, fixture] of Object.entries(config.fixtures)) {
    if (!/^[a-z][a-z0-9_]+$/.test(fixtureKey)) throw new Error(`Invalid General Revit sample fixture key ${fixtureKey}.`);
    if (!fixture.document_title.trim() || !fixture.sample_filename.toLowerCase().endsWith(".rvt")) {
      throw new Error(`${fixtureKey}: sample fixture identity is incomplete.`);
    }
  }
  return config;
}

export function generalRevitFixtureForCase(config: GeneralRevitSampleFixtures, caseId: string): string {
  for (const [fixtureKey, caseIds] of Object.entries(config.case_overrides)) {
    if (caseIds.includes(caseId)) return fixtureKey;
  }
  return config.default_fixture;
}
