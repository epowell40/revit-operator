import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export type ExistingConditionsContractName = "agent_package" | "ground_truth" | "candidate" | "architectural_preview" | "architectural_pixel_measurement" | "registered_mep_observations" | "mep_region_coverage" | "registration_ambiguity" | "architectural_wall_candidate_clarification" | "architectural_opening_classification" | "architectural_door_span_observation" | "architectural_opening_host_resolution";

const FILES: Record<ExistingConditionsContractName, string> = {
  agent_package: "existing_conditions_agent_package.v1.schema.json",
  ground_truth: "existing_conditions_ground_truth.v1.schema.json",
  candidate: "existing_conditions_candidate.v1.schema.json",
  architectural_preview: "existing_conditions_architectural_preview.v1.schema.json",
  architectural_pixel_measurement: "existing_conditions_architectural_pixel_measurement.v1.schema.json",
  registered_mep_observations: "existing_conditions_registered_mep_observations.v1.schema.json",
  mep_region_coverage: "existing_conditions_mep_region_coverage.v1.schema.json",
  registration_ambiguity: "existing_conditions_registration_ambiguity.v1.schema.json",
  architectural_wall_candidate_clarification: "existing_conditions_architectural_wall_candidate_clarification.v1.schema.json",
  architectural_opening_classification: "existing_conditions_architectural_opening_classification.v1.schema.json",
  architectural_door_span_observation: "existing_conditions_architectural_door_span_observation.v1.schema.json",
  architectural_opening_host_resolution: "existing_conditions_architectural_opening_host_resolution.v1.schema.json"
};
const REGISTERED_MEP_V2_FILE = "existing_conditions_registered_mep_observations.v2.schema.json";
const MEP_REGION_COVERAGE_V2_FILE = "existing_conditions_mep_region_coverage.v2.schema.json";
const CANDIDATE_V2_FILE = "existing_conditions_candidate.v2.schema.json";

let validators: Record<ExistingConditionsContractName, ValidateFunction> | null = null;
let registeredMepV2Validator: ValidateFunction | null = null;
let mepRegionCoverageV2Validator: ValidateFunction | null = null;
let candidateV2Validator: ValidateFunction | null = null;

function contractsDirectory(): string {
  const candidates = [
    path.resolve(process.cwd(), "benchmark", "contracts"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../benchmark/contracts")
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, FILES.ground_truth)));
  if (!found) throw new Error(`existing_conditions_contracts_not_found:${candidates.join("|")}`);
  return found;
}

function loadValidators(): Record<ExistingConditionsContractName, ValidateFunction> {
  if (validators) return validators;
  const directory = contractsDirectory();
  const schemas = Object.values(FILES).map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as Record<string, unknown>);
  const registeredMepV2Schema = JSON.parse(fs.readFileSync(path.join(directory, REGISTERED_MEP_V2_FILE), "utf8")) as Record<string, unknown>;
  const mepRegionCoverageV2Schema = JSON.parse(fs.readFileSync(path.join(directory, MEP_REGION_COVERAGE_V2_FILE), "utf8")) as Record<string, unknown>;
  const candidateV2Schema = JSON.parse(fs.readFileSync(path.join(directory, CANDIDATE_V2_FILE), "utf8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  ajv.addSchema(registeredMepV2Schema);
  ajv.addSchema(mepRegionCoverageV2Schema);
  ajv.addSchema(candidateV2Schema);
  registeredMepV2Validator = ajv.getSchema(String(registeredMepV2Schema.$id))!;
  mepRegionCoverageV2Validator = ajv.getSchema(String(mepRegionCoverageV2Schema.$id))!;
  candidateV2Validator = ajv.getSchema(String(candidateV2Schema.$id))!;
  validators = Object.fromEntries(
    (Object.keys(FILES) as ExistingConditionsContractName[]).map((name, index) => [name, ajv.getSchema(String(schemas[index]!.$id))!])
  ) as Record<ExistingConditionsContractName, ValidateFunction>;
  return validators;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}

export function assertExistingConditionsContract(name: ExistingConditionsContractName, value: unknown): void {
  const loaded = loadValidators();
  const schemaVersion = value != null && typeof value === "object" && "schema_version" in value
    ? (value as { schema_version?: unknown }).schema_version
    : undefined;
  const validator = name === "registered_mep_observations" && schemaVersion === 2
    ? registeredMepV2Validator!
    : name === "mep_region_coverage" && schemaVersion === 2
      ? mepRegionCoverageV2Validator!
    : name === "candidate" && schemaVersion === 2
      ? candidateV2Validator!
    : loaded[name];
  if (!validator(value)) throw new Error(`invalid_existing_conditions_${name}_contract:${formatErrors(validator.errors)}`);
}
