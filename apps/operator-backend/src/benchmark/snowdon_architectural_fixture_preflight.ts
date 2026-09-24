import {
  auditLinkedBackgroundModelHealth,
  DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY,
  type LinkedBackgroundModelGateReceipt
} from "../existing_conditions/linked_background_model_gate.js";

export interface SnowdonArchitecturalFixturePreflightOptions {
  enabled: boolean;
  fixture: string;
  expectedDocumentTitle?: string;
  requiresArchitecturalLink?: boolean;
  readModelHealth: () => Promise<unknown>;
  retainReceipt: (receipt: LinkedBackgroundModelGateReceipt) => void;
}

export async function verifySnowdonArchitecturalFixtureBeforeAgent(
  options: SnowdonArchitecturalFixturePreflightOptions
): Promise<LinkedBackgroundModelGateReceipt | null> {
  if (!options.enabled || !(options.requiresArchitecturalLink ?? options.fixture === "snowdon_hvac")) return null;
  const receipt = auditLinkedBackgroundModelHealth(await options.readModelHealth(), {
    ...DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY,
    expected_name_tokens: ["snowdon towers sample architectural"]
  });
  options.retainReceipt(receipt);
  if (receipt.document.title !== (options.expectedDocumentTitle ?? "Snowdon Towers Sample HVAC")) {
    throw new Error(`Snowdon Architectural link preflight observed the wrong active model: '${receipt.document.title || "none"}'.`);
  }
  if (!receipt.passed) {
    throw new Error(`Snowdon Architectural link preflight failed: ${receipt.failure_classifications.join(", ")}.`);
  }
  return receipt;
}
