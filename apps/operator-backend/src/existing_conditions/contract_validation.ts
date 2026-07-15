import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export type ExistingConditionsContractName = "agent_package" | "ground_truth" | "candidate" | "architectural_preview" | "architectural_pixel_measurement" | "registered_mep_observations" | "mep_region_coverage" | "architectural_wall_candidate_clarification" | "architectural_opening_classification" | "architectural_opening_host_resolution";

const FILES: Record<ExistingConditionsContractName, string> = {
  agent_package: "existing_conditions_agent_package.v1.schema.json",
  ground_truth: "existing_conditions_ground_truth.v1.schema.json",
  candidate: "existing_conditions_candidate.v1.schema.json",
  architectural_preview: "existing_conditions_architectural_preview.v1.schema.json",
  architectural_pixel_measurement: "existing_conditions_architectural_pixel_measurement.v1.schema.json",
  registered_mep_observations: "existing_conditions_registered_mep_observations.v1.schema.json",
  mep_region_coverage: "existing_conditions_mep_region_coverage.v1.schema.json",
  architectural_wall_candidate_clarification: "existing_conditions_architectural_wall_candidate_clarification.v1.schema.json",
  architectural_opening_classification: "existing_conditions_architectural_opening_classification.v1.schema.json",
  architectural_opening_host_resolution: "existing_conditions_architectural_opening_host_resolution.v1.schema.json"
};

let validators: Record<ExistingConditionsContractName, ValidateFunction> | null = null;

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
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  validators = Object.fromEntries(
    (Object.keys(FILES) as ExistingConditionsContractName[]).map((name, index) => [name, ajv.getSchema(String(schemas[index]!.$id))!])
  ) as Record<ExistingConditionsContractName, ValidateFunction>;
  return validators;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}

export function assertExistingConditionsContract(name: ExistingConditionsContractName, value: unknown): void {
  const validator = loadValidators()[name];
  if (!validator(value)) throw new Error(`invalid_existing_conditions_${name}_contract:${formatErrors(validator.errors)}`);
}
