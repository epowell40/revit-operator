import path from "node:path";
import { benchmarkDataRoot, readJsonFile } from "./files.js";
import type {
  BenchmarkConfigBundle,
  BenchmarkEscalationConfig,
  BenchmarkExperimentConfig,
  BenchmarkPricingConfig
} from "./types.js";

function configsDir(): string {
  return path.join(benchmarkDataRoot(), "configs");
}

function requireFiniteNumber(value: unknown, field: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) throw new Error(`Missing required numeric field '${field}'.`);
  return num;
}

export function loadBenchmarkConfigBundle(): BenchmarkConfigBundle {
  const bundle = readJsonFile<BenchmarkConfigBundle>(path.join(configsDir(), "experiment_matrix.json"));
  if (!Array.isArray(bundle.configs) || bundle.configs.length === 0) {
    throw new Error("Benchmark config bundle does not contain any configs.");
  }
  return bundle;
}

export function loadBenchmarkPricingConfig(): BenchmarkPricingConfig {
  const pricing = readJsonFile<BenchmarkPricingConfig>(path.join(configsDir(), "pricing.json"));
  if (!pricing.models || Object.keys(pricing.models).length === 0) {
    throw new Error("Pricing config is empty.");
  }
  return pricing;
}

export function loadBenchmarkEscalationConfig(): BenchmarkEscalationConfig {
  const escalation = readJsonFile<BenchmarkEscalationConfig>(path.join(configsDir(), "escalation.json"));
  requireFiniteNumber(escalation.executor_failures_before_escalation, "executor_failures_before_escalation");
  requireFiniteNumber(escalation.confidence_threshold, "confidence_threshold");
  return {
    executor_failures_before_escalation: Math.max(1, Math.round(escalation.executor_failures_before_escalation)),
    confidence_threshold: Math.min(1, Math.max(0, escalation.confidence_threshold)),
    high_impact_action_keywords: Array.isArray(escalation.high_impact_action_keywords)
      ? escalation.high_impact_action_keywords.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : [],
    high_impact_target_keywords: Array.isArray(escalation.high_impact_target_keywords)
      ? escalation.high_impact_target_keywords.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : []
  };
}

export function getConfigById(bundle: BenchmarkConfigBundle, configId: string): BenchmarkExperimentConfig {
  const config = bundle.configs.find((entry) => entry.id === configId);
  if (!config) throw new Error(`Unknown benchmark config '${configId}'.`);
  return config;
}
