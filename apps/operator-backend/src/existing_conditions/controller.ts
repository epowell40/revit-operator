export type ExistingConditionsDiscipline = "mechanical" | "plumbing" | "electrical" | "architectural" | "mixed";

export type ExistingConditionsControllerPhase =
  | "inspect"
  | "plan"
  | "clarify"
  | "dry_run"
  | "apply"
  | "verify_native"
  | "verify_visual"
  | "repair"
  | "complete"
  | "blocked";

export type ExistingConditionsVisibleEvidence = {
  role: string;
  sha256: string;
};

export type ExistingConditionsPlanElement = {
  plan_key: string;
  discipline?: Exclude<ExistingConditionsDiscipline, "mixed"> | "architectural";
  category: string;
  role: string;
  action: "create" | "connect" | "host" | "assign_circuit" | "set_parameter";
  confidence: number;
  assumptions: string[];
  source_observation_ids?: string[];
  required_source_attributes?: string[];
};

export type ExistingConditionsSourceObservation = {
  observation_id: string;
  evidence_role: string;
  discipline: Exclude<ExistingConditionsDiscipline, "mixed"> | "architectural";
  category: string;
  role: string;
  visibility: "clear" | "partial" | "occluded";
  confidence: number;
  supported_attributes: string[];
};

export type ExistingConditionsAmbiguity = {
  id: string;
  topic: string;
  description: string;
  material: boolean;
  confidence: number;
  choices: string[];
  related_plan_keys?: string[];
  material_attributes?: string[];
  resolution?: string | null;
  resolution_basis?: "user_direction" | "project_precedent" | "legible_source_evidence" | null;
  resolution_evidence_reference?: string | null;
};

export type ExistingConditionsControllerHistoryEntry = {
  revision: number;
  from: ExistingConditionsControllerPhase;
  to: ExistingConditionsControllerPhase;
  event: ExistingConditionsControllerEvent["type"];
  summary: string;
};

export type ExistingConditionsControllerState = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  discipline: ExistingConditionsDiscipline;
  phase: ExistingConditionsControllerPhase;
  revision: number;
  allowed_categories: string[];
  maximum_created_elements: number;
  expected_visible_evidence: ExistingConditionsVisibleEvidence[];
  require_source_observation_grounding: boolean;
  material_confidence_threshold: number;
  max_repairs: number;
  repairs_attempted: number;
  inspection_receipt: {
    native_readback: boolean;
    inventory_complete: boolean;
    discovered_element_keys: string[];
    surrounding_anchor_keys: string[];
    source_observations_complete: boolean;
    source_observations: ExistingConditionsSourceObservation[];
  } | null;
  plan: ExistingConditionsPlanElement[];
  ambiguities: ExistingConditionsAmbiguity[];
  clarification_question: string | null;
  dry_run_receipt: {
    status: "pass";
    planned_element_keys: string[];
    receipt_sha256: string;
  } | null;
  apply_receipt: {
    status: "pass";
    changed_element_keys: string[];
    created_element_keys: string[];
    out_of_scope_changed_element_keys: string[];
    receipt_sha256: string;
  } | null;
  native_verification: {
    passed: boolean;
    native_readback: boolean;
    failure_classifications: string[];
    receipt_sha256: string;
  } | null;
  visual_verification: {
    passed: boolean;
    capture_sha256: string;
    pdf_sha256: string;
    failure_classifications: string[];
  } | null;
  blocker: string | null;
  history: ExistingConditionsControllerHistoryEntry[];
};

export type ExistingConditionsControllerEvent =
  | {
      type: "inspection_completed";
      visible_evidence: ExistingConditionsVisibleEvidence[];
      native_readback: boolean;
      inventory_complete?: boolean;
      discovered_element_keys: string[];
      surrounding_anchor_keys: string[];
      source_observations_complete?: boolean;
      source_observations?: ExistingConditionsSourceObservation[];
    }
  | {
      type: "plan_submitted";
      elements: ExistingConditionsPlanElement[];
      ambiguities?: ExistingConditionsAmbiguity[];
    }
  | {
      type: "clarification_answered";
      answers: Array<{
        ambiguity_id: string;
        resolution: string;
        basis?: "user_direction" | "project_precedent" | "legible_source_evidence";
        evidence_reference?: string;
      }>;
    }
  | {
      type: "dry_run_completed";
      passed: boolean;
      planned_element_keys: string[];
      out_of_scope_categories?: string[];
      receipt_sha256: string;
      failure_reason?: string;
    }
  | {
      type: "apply_completed";
      passed: boolean;
      changed_element_keys: string[];
      created_element_keys?: string[];
      out_of_scope_changed_element_keys: string[];
      receipt_sha256: string;
      failure_reason?: string;
    }
  | {
      type: "native_verification_completed";
      passed: boolean;
      native_readback: boolean;
      failure_classifications?: string[];
      receipt_sha256: string;
    }
  | {
      type: "visual_verification_completed";
      passed: boolean;
      capture_sha256: string;
      pdf_sha256: string;
      failure_classifications?: string[];
    }
  | {
      type: "repair_completed";
      dry_run_passed: boolean;
      apply_passed: boolean;
      changed_element_keys: string[];
      out_of_scope_changed_element_keys: string[];
      receipt_sha256: string;
      failure_reason?: string;
    }
  | {
      type: "block";
      reason: string;
    };

export type ExistingConditionsControllerInit = {
  fixture_id: string;
  scope_id: string;
  discipline: ExistingConditionsDiscipline;
  allowed_categories: string[];
  maximum_created_elements: number;
  visible_evidence: ExistingConditionsVisibleEvidence[];
  require_source_observation_grounding?: boolean;
  material_confidence_threshold?: number;
  max_repairs?: number;
};

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return cleanText(value).toLowerCase().replace(/\s+/g, " ");
}

function uniqueText(values: unknown[]): string[] {
  const byNormalized = new Map<string, string>();
  for (const value of values) {
    const text = cleanText(value);
    if (text && !byNormalized.has(normalized(text))) byNormalized.set(normalized(text), text);
  }
  return [...byNormalized.values()];
}

function requireSha256(value: unknown, label: string): string {
  const text = cleanText(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label}_must_be_sha256`);
  return text;
}

function requireNonEmpty(value: unknown, label: string): string {
  const text = cleanText(value);
  if (!text) throw new Error(`${label}_is_required`);
  return text;
}

function evidenceMap(values: ExistingConditionsVisibleEvidence[]): Map<string, string> {
  return new Map(values.map((entry) => [normalized(entry.role), normalized(entry.sha256)]));
}

function assertVisibleEvidenceUnchanged(
  expected: ExistingConditionsVisibleEvidence[],
  actual: ExistingConditionsVisibleEvidence[]
): void {
  const expectedMap = evidenceMap(expected);
  const actualMap = evidenceMap(actual);
  for (const [role, hash] of expectedMap) {
    if (!hash || actualMap.get(role) !== hash) throw new Error(`visible_evidence_changed:${role}`);
  }
}

function assertPhase(state: ExistingConditionsControllerState, phase: ExistingConditionsControllerPhase): void {
  if (state.phase !== phase) throw new Error(`invalid_phase:${state.phase}:expected:${phase}`);
}

function clone(state: ExistingConditionsControllerState): ExistingConditionsControllerState {
  return JSON.parse(JSON.stringify(state)) as ExistingConditionsControllerState;
}

function transition(
  state: ExistingConditionsControllerState,
  event: ExistingConditionsControllerEvent,
  nextPhase: ExistingConditionsControllerPhase,
  summary: string
): ExistingConditionsControllerState {
  const next = clone(state);
  next.revision += 1;
  next.phase = nextPhase;
  next.history.push({ revision: next.revision, from: state.phase, to: nextPhase, event: event.type, summary });
  return next;
}

function block(
  state: ExistingConditionsControllerState,
  event: ExistingConditionsControllerEvent,
  reason: string
): ExistingConditionsControllerState {
  const next = transition(state, event, "blocked", reason);
  next.blocker = reason;
  return next;
}

function sameSet(a: string[], b: string[]): boolean {
  const left = uniqueText(a).map(normalized).sort();
  const right = uniqueText(b).map(normalized).sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildClarificationQuestion(ambiguities: ExistingConditionsAmbiguity[]): string | null {
  const unresolved = ambiguities.filter((entry) => entry.material && !cleanText(entry.resolution));
  if (unresolved.length === 0) return null;
  const details = unresolved.map((entry) => {
    const choices = uniqueText(entry.choices).join(" / ");
    return choices ? `${entry.topic}: ${entry.description} (${choices})` : `${entry.topic}: ${entry.description}`;
  });
  return `Before I model this bounded scope, please resolve: ${details.join("; ")}`;
}

function validatePlan(
  state: ExistingConditionsControllerState,
  elements: ExistingConditionsPlanElement[]
): ExistingConditionsPlanElement[] {
  if (elements.length === 0) throw new Error("reconstruction_plan_is_empty");
  if (elements.length > state.maximum_created_elements) throw new Error("maximum_created_elements_exceeded");
  const allowed = new Set(state.allowed_categories.map(normalized));
  const seen = new Set<string>();
  return elements.map((raw, index) => {
    const planKey = requireNonEmpty(raw.plan_key, `plan[${index}].plan_key`);
    const key = normalized(planKey);
    if (seen.has(key)) throw new Error(`duplicate_plan_key:${planKey}`);
    seen.add(key);
    const category = requireNonEmpty(raw.category, `plan[${index}].category`);
    if (!allowed.has(normalized(category))) throw new Error(`out_of_scope_category:${category}`);
    const discipline = normalized(raw.discipline);
    if (state.require_source_observation_grounding
      && !["mechanical", "plumbing", "electrical", "architectural"].includes(discipline)) {
      throw new Error(`plan[${index}].discipline_required`);
    }
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`plan[${index}].confidence_out_of_range`);
    }
    return {
      plan_key: planKey,
      discipline: discipline ? discipline as ExistingConditionsPlanElement["discipline"] : undefined,
      category,
      role: requireNonEmpty(raw.role, `plan[${index}].role`),
      action: raw.action,
      confidence,
      assumptions: uniqueText(raw.assumptions ?? []),
      source_observation_ids: uniqueText(raw.source_observation_ids ?? []),
      required_source_attributes: uniqueText(raw.required_source_attributes ?? [])
    };
  });
}

function validateSourceObservations(
  state: ExistingConditionsControllerState,
  values: ExistingConditionsSourceObservation[]
): ExistingConditionsSourceObservation[] {
  const visibleRoles = new Set(state.expected_visible_evidence.map((entry) => normalized(entry.role)));
  const disciplines = new Set(["mechanical", "plumbing", "electrical", "architectural"]);
  const visibilityKinds = new Set(["clear", "partial", "occluded"]);
  const seen = new Set<string>();
  return values.map((raw, index) => {
    const observationId = requireNonEmpty(raw.observation_id, `source_observation[${index}].observation_id`);
    if (seen.has(normalized(observationId))) throw new Error(`duplicate_source_observation_id:${observationId}`);
    seen.add(normalized(observationId));
    const evidenceRole = requireNonEmpty(raw.evidence_role, `source_observation[${index}].evidence_role`);
    if (!visibleRoles.has(normalized(evidenceRole))) throw new Error(`unknown_source_evidence_role:${evidenceRole}`);
    const discipline = normalized(raw.discipline);
    if (!disciplines.has(discipline)) throw new Error(`source_observation[${index}].discipline_invalid`);
    const visibility = normalized(raw.visibility);
    if (!visibilityKinds.has(visibility)) throw new Error(`source_observation[${index}].visibility_invalid`);
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`source_observation[${index}].confidence_out_of_range`);
    }
    return {
      observation_id: observationId,
      evidence_role: evidenceRole,
      discipline: discipline as ExistingConditionsSourceObservation["discipline"],
      category: requireNonEmpty(raw.category, `source_observation[${index}].category`),
      role: requireNonEmpty(raw.role, `source_observation[${index}].role`),
      visibility: visibility as ExistingConditionsSourceObservation["visibility"],
      confidence,
      supported_attributes: uniqueText(raw.supported_attributes ?? [])
    };
  });
}

function validateAmbiguities(
  state: ExistingConditionsControllerState,
  values: ExistingConditionsAmbiguity[]
): ExistingConditionsAmbiguity[] {
  const seen = new Set<string>();
  return values.map((raw, index) => {
    const id = requireNonEmpty(raw.id, `ambiguity[${index}].id`);
    if (seen.has(normalized(id))) throw new Error(`duplicate_ambiguity_id:${id}`);
    seen.add(normalized(id));
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`ambiguity[${index}].confidence_out_of_range`);
    }
    const material = raw.material === true || confidence < state.material_confidence_threshold;
    return {
      id,
      topic: requireNonEmpty(raw.topic, `ambiguity[${index}].topic`),
      description: requireNonEmpty(raw.description, `ambiguity[${index}].description`),
      material,
      confidence,
      choices: uniqueText(raw.choices ?? []),
      related_plan_keys: uniqueText(raw.related_plan_keys ?? []),
      material_attributes: uniqueText(raw.material_attributes ?? []),
      resolution: cleanText(raw.resolution) || null,
      resolution_basis: raw.resolution_basis ?? null,
      resolution_evidence_reference: cleanText(raw.resolution_evidence_reference) || null
    };
  });
}

function addRequiredSourceGroundingAmbiguities(
  state: ExistingConditionsControllerState,
  plan: ExistingConditionsPlanElement[],
  ambiguities: ExistingConditionsAmbiguity[]
): ExistingConditionsAmbiguity[] {
  if (!state.require_source_observation_grounding) return ambiguities;
  const result = [...ambiguities];
  const observations = state.inspection_receipt?.source_observations ?? [];
  const byId = new Map(observations.map((entry) => [normalized(entry.observation_id), entry]));
  const planKeys = new Set(plan.map((entry) => normalized(entry.plan_key)));
  for (const ambiguity of result) {
    for (const key of ambiguity.related_plan_keys ?? []) {
      if (!planKeys.has(normalized(key))) throw new Error(`ambiguity_unknown_plan_key:${key}`);
    }
  }
  for (const element of plan) {
    const citedIds = uniqueText(element.source_observation_ids ?? []);
    if (citedIds.length === 0) throw new Error(`plan_source_observation_required:${element.plan_key}`);
    const cited = citedIds.map((id) => {
      const observation = byId.get(normalized(id));
      if (!observation) throw new Error(`plan_source_observation_unknown:${element.plan_key}:${id}`);
      return observation;
    });
    const categoryMismatch = cited.find((observation) => normalized(observation.category) !== normalized(element.category));
    if (categoryMismatch) {
      throw new Error(`plan_source_observation_category_mismatch:${element.plan_key}:${categoryMismatch.observation_id}`);
    }
    const disciplineMismatch = cited.find((observation) => normalized(observation.discipline) !== normalized(element.discipline));
    if (disciplineMismatch) {
      throw new Error(`plan_source_observation_discipline_mismatch:${element.plan_key}:${disciplineMismatch.observation_id}`);
    }
    const requiredAttributes = uniqueText(element.required_source_attributes ?? []);
    if (requiredAttributes.length === 0) throw new Error(`plan_required_source_attributes_missing:${element.plan_key}`);
    let relatedMaterial = result.filter((ambiguity) => ambiguity.material
      && (ambiguity.related_plan_keys ?? []).some((key) => normalized(key) === normalized(element.plan_key)));
    const effectiveConfidence = Math.min(element.confidence, ...cited.map((observation) => observation.confidence));
    if (effectiveConfidence < state.material_confidence_threshold && relatedMaterial.length === 0) {
      result.push({
        id: `source-confidence:${element.plan_key}`,
        topic: `${element.role} source confidence`,
        description: `The cited source evidence for ${element.plan_key} is below the material confidence threshold; confirm ${requiredAttributes.join(", ")}.`,
        material: true,
        confidence: effectiveConfidence,
        choices: [],
        related_plan_keys: [element.plan_key],
        material_attributes: requiredAttributes,
        resolution: null,
        resolution_basis: null,
        resolution_evidence_reference: null
      });
      relatedMaterial = result.filter((ambiguity) => ambiguity.material
        && (ambiguity.related_plan_keys ?? []).some((key) => normalized(key) === normalized(element.plan_key)));
    }
    const supported = new Set(cited.flatMap((observation) => observation.supported_attributes).map(normalized));
    for (const attribute of requiredAttributes) {
      if (supported.has(normalized(attribute))) continue;
      const covered = relatedMaterial.some((ambiguity) => (ambiguity.material_attributes ?? [])
        .some((candidate) => normalized(candidate) === normalized(attribute)));
      if (!covered) {
        result.push({
          id: `source-attribute:${element.plan_key}:${normalized(attribute).replace(/[^a-z0-9]+/g, "-")}`,
          topic: `${element.role} ${attribute}`,
          description: `The cited source evidence does not establish ${attribute} for ${element.plan_key}.`,
          material: true,
          confidence: effectiveConfidence,
          choices: [],
          related_plan_keys: [element.plan_key],
          material_attributes: [attribute],
          resolution: null,
          resolution_basis: null,
          resolution_evidence_reference: null
        });
      }
    }
  }
  return result;
}

export function createExistingConditionsControllerState(
  input: ExistingConditionsControllerInit
): ExistingConditionsControllerState {
  const allowedCategories = uniqueText(input.allowed_categories ?? []);
  if (allowedCategories.length === 0) throw new Error("allowed_categories_are_required");
  const maximumCreatedElements = Number(input.maximum_created_elements);
  if (!Number.isInteger(maximumCreatedElements) || maximumCreatedElements < 1 || maximumCreatedElements > 500) {
    throw new Error("maximum_created_elements_out_of_range");
  }
  const evidence = (input.visible_evidence ?? []).map((entry, index) => ({
    role: requireNonEmpty(entry.role, `visible_evidence[${index}].role`),
    sha256: requireSha256(entry.sha256, `visible_evidence[${index}].sha256`)
  }));
  if (evidence.length === 0) throw new Error("visible_evidence_is_required");
  const threshold = input.material_confidence_threshold ?? 0.75;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("material_confidence_threshold_out_of_range");
  }
  const maxRepairs = input.max_repairs ?? 2;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10) throw new Error("max_repairs_out_of_range");
  return {
    schema_version: 1,
    fixture_id: requireNonEmpty(input.fixture_id, "fixture_id"),
    scope_id: requireNonEmpty(input.scope_id, "scope_id"),
    discipline: input.discipline,
    phase: "inspect",
    revision: 0,
    allowed_categories: allowedCategories,
    maximum_created_elements: maximumCreatedElements,
    expected_visible_evidence: evidence,
    require_source_observation_grounding: input.require_source_observation_grounding === true,
    material_confidence_threshold: threshold,
    max_repairs: maxRepairs,
    repairs_attempted: 0,
    inspection_receipt: null,
    plan: [],
    ambiguities: [],
    clarification_question: null,
    dry_run_receipt: null,
    apply_receipt: null,
    native_verification: null,
    visual_verification: null,
    blocker: null,
    history: []
  };
}

export function advanceExistingConditionsController(
  state: ExistingConditionsControllerState,
  event: ExistingConditionsControllerEvent
): ExistingConditionsControllerState {
  if (state.phase === "complete" || state.phase === "blocked") {
    throw new Error(`terminal_phase:${state.phase}`);
  }
  if (event.type === "block") return block(state, event, requireNonEmpty(event.reason, "block.reason"));

  if (event.type === "inspection_completed") {
    assertPhase(state, "inspect");
    assertVisibleEvidenceUnchanged(state.expected_visible_evidence, event.visible_evidence);
    if (!event.native_readback) return block(state, event, "inspection_missing_native_readback");
    if (event.inventory_complete === false) return block(state, event, "inspection_inventory_incomplete");
    if (state.require_source_observation_grounding && event.source_observations_complete !== true) {
      return block(state, event, "source_observation_inventory_incomplete");
    }
    const sourceObservations = validateSourceObservations(state, event.source_observations ?? []);
    if (state.require_source_observation_grounding && sourceObservations.length === 0) {
      return block(state, event, "source_observations_missing");
    }
    const next = transition(state, event, "plan", "Bounded evidence and native context inspected.");
    next.inspection_receipt = {
      native_readback: true,
      inventory_complete: true,
      discovered_element_keys: uniqueText(event.discovered_element_keys ?? []),
      surrounding_anchor_keys: uniqueText(event.surrounding_anchor_keys ?? []),
      source_observations_complete: event.source_observations_complete === true,
      source_observations: sourceObservations
    };
    return next;
  }

  if (event.type === "plan_submitted") {
    assertPhase(state, "plan");
    const plan = validatePlan(state, event.elements ?? []);
    const ambiguities = addRequiredSourceGroundingAmbiguities(
      state,
      plan,
      validateAmbiguities(state, event.ambiguities ?? [])
    );
    const question = buildClarificationQuestion(ambiguities);
    const next = transition(
      state,
      event,
      question ? "clarify" : "dry_run",
      question ? "Material ambiguity requires one consolidated clarification." : "Bounded reconstruction plan accepted for dry-run."
    );
    next.plan = plan;
    next.ambiguities = ambiguities;
    next.clarification_question = question;
    return next;
  }

  if (event.type === "clarification_answered") {
    assertPhase(state, "clarify");
    const answers = new Map<string, { resolution: string; basis: string; evidence_reference: string }>();
    for (const answer of event.answers ?? []) {
      const id = normalized(answer.ambiguity_id);
      if (!state.ambiguities.some((entry) => normalized(entry.id) === id)) throw new Error(`clarification_unknown_ambiguity:${answer.ambiguity_id}`);
      if (answers.has(id)) throw new Error(`clarification_duplicate_answer:${answer.ambiguity_id}`);
      answers.set(id, {
        resolution: cleanText(answer.resolution),
        basis: normalized(answer.basis),
        evidence_reference: cleanText(answer.evidence_reference)
      });
    }
    const nextAmbiguities = state.ambiguities.map((entry) => ({
      ...entry,
      resolution: answers.get(normalized(entry.id))?.resolution || entry.resolution || null,
      resolution_basis: (answers.get(normalized(entry.id))?.basis || entry.resolution_basis || null) as ExistingConditionsAmbiguity["resolution_basis"],
      resolution_evidence_reference: answers.get(normalized(entry.id))?.evidence_reference || entry.resolution_evidence_reference || null
    }));
    for (const ambiguity of nextAmbiguities) {
      if (!ambiguity.material || !cleanText(ambiguity.resolution)) continue;
      const answer = answers.get(normalized(ambiguity.id));
      if (ambiguity.choices.length > 0 && !ambiguity.choices.some((choice) => normalized(choice) === normalized(ambiguity.resolution))) {
        throw new Error(`clarification_resolution_not_offered_choice:${ambiguity.id}`);
      }
      if (ambiguity.choices.length === 0 && answer) {
        if (!answer.basis) throw new Error(`clarification_resolution_basis_required:${ambiguity.id}`);
        if (!["user_direction", "project_precedent", "legible_source_evidence"].includes(answer.basis)) {
          throw new Error(`clarification_resolution_basis_invalid:${ambiguity.id}`);
        }
        if (answer.basis !== "user_direction" && !answer.evidence_reference) {
          throw new Error(`clarification_evidence_reference_required:${ambiguity.id}`);
        }
      }
    }
    const question = buildClarificationQuestion(nextAmbiguities);
    if (question) throw new Error("material_ambiguity_unresolved");
    const next = transition(state, event, "dry_run", "Material ambiguity resolved; plan may be preflighted.");
    next.ambiguities = nextAmbiguities;
    next.clarification_question = null;
    return next;
  }

  if (event.type === "dry_run_completed") {
    assertPhase(state, "dry_run");
    if (!event.passed) return block(state, event, cleanText(event.failure_reason) || "dry_run_failed");
    if ((event.out_of_scope_categories ?? []).length > 0) {
      return block(state, event, `dry_run_scope_broadened:${uniqueText(event.out_of_scope_categories ?? []).join(",")}`);
    }
    const planKeys = state.plan.map((entry) => entry.plan_key);
    if (!sameSet(planKeys, event.planned_element_keys ?? [])) return block(state, event, "dry_run_plan_drift");
    const next = transition(state, event, "apply", "Dry-run matched the exact bounded plan.");
    next.dry_run_receipt = {
      status: "pass",
      planned_element_keys: uniqueText(event.planned_element_keys ?? []),
      receipt_sha256: requireSha256(event.receipt_sha256, "dry_run.receipt_sha256")
    };
    return next;
  }

  if (event.type === "apply_completed") {
    assertPhase(state, "apply");
    if (!event.passed) return block(state, event, cleanText(event.failure_reason) || "apply_failed");
    const outOfScope = uniqueText(event.out_of_scope_changed_element_keys ?? []);
    if (outOfScope.length > 0) return block(state, event, `out_of_scope_write:${outOfScope.join(",")}`);
    const changed = uniqueText(event.changed_element_keys ?? []);
    const knownExisting = new Set([
      ...(state.inspection_receipt?.discovered_element_keys ?? []),
      ...(state.inspection_receipt?.surrounding_anchor_keys ?? [])
    ].map(normalized));
    const created = event.created_element_keys
      ? uniqueText(event.created_element_keys)
      : changed.filter((key) => !knownExisting.has(normalized(key)));
    const changedNormalized = new Set(changed.map(normalized));
    if (created.some((key) => !changedNormalized.has(normalized(key)))) {
      return block(state, event, "created_element_not_in_changed_elements");
    }
    if (created.length > state.maximum_created_elements) return block(state, event, "maximum_created_elements_exceeded");
    const next = transition(state, event, "verify_native", "Approved plan applied inside the bounded scope.");
    next.apply_receipt = {
      status: "pass",
      changed_element_keys: changed,
      created_element_keys: created,
      out_of_scope_changed_element_keys: [],
      receipt_sha256: requireSha256(event.receipt_sha256, "apply.receipt_sha256")
    };
    return next;
  }

  if (event.type === "native_verification_completed") {
    assertPhase(state, "verify_native");
    const failures = uniqueText(event.failure_classifications ?? []);
    const receipt = {
      passed: event.passed,
      native_readback: event.native_readback,
      failure_classifications: failures,
      receipt_sha256: requireSha256(event.receipt_sha256, "native_verification.receipt_sha256")
    };
    if (!event.native_readback) return block(state, event, "native_verification_missing_readback");
    const nextPhase: ExistingConditionsControllerPhase = event.passed
      ? "verify_visual"
      : state.repairs_attempted < state.max_repairs ? "repair" : "blocked";
    const next = transition(
      state,
      event,
      nextPhase,
      event.passed ? "Native readback passed; focused visual verification remains." : "Native verification found a bounded repair need."
    );
    next.native_verification = receipt;
    if (nextPhase === "blocked") next.blocker = failures.join(",") || "native_verification_failed";
    return next;
  }

  if (event.type === "visual_verification_completed") {
    assertPhase(state, "verify_visual");
    const failures = uniqueText(event.failure_classifications ?? []);
    const nextPhase: ExistingConditionsControllerPhase = event.passed
      ? "complete"
      : state.repairs_attempted < state.max_repairs ? "repair" : "blocked";
    const next = transition(
      state,
      event,
      nextPhase,
      event.passed ? "Native and visual verification passed." : "Visual review found a bounded repair need."
    );
    next.visual_verification = {
      passed: event.passed,
      capture_sha256: requireSha256(event.capture_sha256, "visual_verification.capture_sha256"),
      pdf_sha256: requireSha256(event.pdf_sha256, "visual_verification.pdf_sha256"),
      failure_classifications: failures
    };
    if (nextPhase === "blocked") next.blocker = failures.join(",") || "visual_verification_failed";
    return next;
  }

  if (event.type === "repair_completed") {
    assertPhase(state, "repair");
    const outOfScope = uniqueText(event.out_of_scope_changed_element_keys ?? []);
    if (outOfScope.length > 0) return block(state, event, `repair_out_of_scope_write:${outOfScope.join(",")}`);
    if (!event.dry_run_passed || !event.apply_passed) {
      return block(state, event, cleanText(event.failure_reason) || "repair_failed");
    }
    const next = transition(state, event, "verify_native", "Bounded repair applied; native and visual verification must repeat.");
    next.repairs_attempted += 1;
    next.native_verification = null;
    next.visual_verification = null;
    next.apply_receipt = {
      status: "pass",
      changed_element_keys: uniqueText(event.changed_element_keys ?? []),
      created_element_keys: state.apply_receipt?.created_element_keys ?? [],
      out_of_scope_changed_element_keys: [],
      receipt_sha256: requireSha256(event.receipt_sha256, "repair.receipt_sha256")
    };
    return next;
  }

  const exhaustive: never = event;
  throw new Error(`unsupported_event:${String((exhaustive as { type?: unknown }).type ?? "unknown")}`);
}

export function getExistingConditionsControllerNextAction(state: ExistingConditionsControllerState): string {
  const actions: Record<ExistingConditionsControllerPhase, string> = {
    inspect: "Inspect the bounded redacted model, visible evidence, surrounding anchors, and project precedent.",
    plan: "Submit an exact bounded reconstruction plan and material ambiguities.",
    clarify: state.clarification_question ?? "Resolve the material ambiguity before any write.",
    dry_run: "Dry-run every planned model write and prove the scope did not broaden.",
    apply: "Apply only the exact dry-run plan under the normal write grant.",
    verify_native: "Read back native geometry, attributes, systems, relationships, and out-of-scope changes.",
    verify_visual: "Inspect a focused Revit capture and post-change PDF for omissions and drawing defects.",
    repair: "Dry-run and apply one bounded repair, then repeat native and visual verification.",
    complete: "Emit the final run receipt and benchmark candidate package.",
    blocked: state.blocker ?? "Report the blocker and preserve all receipts."
  };
  return actions[state.phase];
}
