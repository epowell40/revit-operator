type Row = Record<string, any>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sameIds = (actual: unknown, expected: number[]): boolean => Array.isArray(actual)
  && actual.length === expected.length && actual.every(id)
  && new Set(actual).size === actual.length && actual.every(value => expected.includes(value));
const token = (value: unknown): string => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const point = (value: unknown): value is {x:number;y:number;z:number} => {
  const p = row(value); return [p.x,p.y,p.z].every(v => typeof v === "number" && Number.isFinite(v));
};
const near = (a: unknown, b: number, tolerance = 1e-4): boolean => Number.isFinite(Number(a)) && Math.abs(Number(a)-b) <= tolerance;
const diameter = (value: unknown): number | null => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:\"|in)\s*$/i.exec(String(value ?? ""));
  return match ? Number(match[1]) / 12 : null;
};

export function registeredStageDuctBranchInputV2(input: unknown): boolean {
  const request = row(input), body = row(request.body);
  if (request.method !== "POST" || request.path !== "/revit/existing-conditions-mep-draft-workflow"
    || body.dryRun !== false || body.verify !== true || !Array.isArray(body.priorActionOutputs)
    || body.priorActionOutputs.length !== 0 || !Array.isArray(body.operations) || body.operations.length !== 1
    || !id(body.maximumCreatedElements) || body.maximumCreatedElements > 64) return false;
  const action = row(body.operations[0]), branch = row(action.apply_body);
  const points = branch.branchPoints;
  return action.path === "/revit/connect-mep-branch" && typeof action.action_key === "string"
    && action.action_key.startsWith("registered-branch:") && body.stageKey === `operation:${action.action_key}`
    && Array.isArray(action.depends_on) && action.depends_on.length === 0
    && id(action.expected_created_min) && id(action.expected_created_max)
    && action.expected_created_min >= 2 && action.expected_created_min <= action.expected_created_max
    && action.expected_created_max <= body.maximumCreatedElements
    && branch.kind === "duct" && branch.connectionMode === "tee" && id(branch.mainElementId)
    && branch.verify === true && id(branch.viewId) && typeof branch.levelName === "string"
    && diameter(branch.branchSize) !== null && Array.isArray(points) && points.length >= 2 && points.length <= 12
    && points.every(point) && !Object.hasOwn(branch, "dryRun") && !Object.hasOwn(branch, "apply");
}

/** An independent post-commit read must prove the split main, tee, each branch
 * segment and fitting, with precisely the declared far construction end open. */
export function registeredStageDuctBranchReadbackMatchesV2(input: unknown, affected: readonly string[],
  nativeApply: unknown, parameters: unknown, connectors: unknown): boolean {
  if (!registeredStageDuctBranchInputV2(input)) return false;
  const body = row(row(input).body), action = row(body.operations[0]), branch = row(action.apply_body);
  const native = row(nativeApply), op = Array.isArray(native.operations) && native.operations.length === 1 ? row(native.operations[0]) : {};
  const result = row(op.response);
  if (native.schema !== "operator.existing_conditions_mep_draft_workflow.v1"
    || native.inputFingerprintSha256 !== body.inputFingerprintSha256 || native.stageKey !== body.stageKey
    || native.status !== "Applied" || native.dryRun !== false || native.transactionGroupRolledBack !== false
    || native.rollbackVerified !== true || native.atomic !== true || native.error != null
    || native.failedOperation != null || native.operationCount !== 1 || native.priorActionOutputCount !== 0
    || op.actionKey !== action.action_key || op.path !== action.path
    || result.status !== "CreatedWithSplitTee" || result.dryRun !== false || result.applyStatus !== "AppliedSplitTee"
    || result.rolledBack === true || row(result.main).id !== branch.mainElementId) return false;
  const created = native.createdElementIds;
  const branchIds = result.createdBranchElementIds, fittingIds = result.createdFittingIds,
    splitIds = result.splitMainSegmentIds;
  if (!Array.isArray(created) || !Array.isArray(branchIds) || !Array.isArray(fittingIds) || !Array.isArray(splitIds)
    || !branchIds.every(id) || !fittingIds.every(id) || !splitIds.every(id)
    || branchIds.length !== branch.branchPoints.length - 1 || fittingIds.length !== branchIds.length
    || splitIds.length !== 2 || !splitIds.includes(branch.mainElementId)
    || !sameIds(created, [...branchIds, ...fittingIds, ...splitIds.filter((value: number) => value !== branch.mainElementId)])
    || created.length < action.expected_created_min || created.length > action.expected_created_max
    || !sameIds(op.createdElementIds, created)
    || !sameIds(affected.map(value => /^element_id:[1-9][0-9]*$/.test(value) ? Number(value.slice(11)) : NaN), created)) return false;
  const selected = row(result.selected), type = row(selected.type), system = row(selected.system), level = row(selected.level);
  const size = diameter(branch.branchSize)!;
  if (!id(type.id) || token(system.name) !== "returnair" && token(system.name) !== "supplyair" && token(system.name) !== "exhaustair"
    || !id(level.id) || level.name !== branch.levelName || !near(row(result.branchPlan).requestedSize === branch.branchSize ? size : NaN, size)
    || !Array.isArray(row(result.branchPlan).points) || row(result.branchPlan).points.length !== branch.branchPoints.length
    || row(result.branchPlan).points.some((value: unknown, index: number) => !point(value)
      || !["x","y","z"].every(axis => near(row(value)[axis], row(branch.branchPoints[index])[axis], 1e-6)))) return false;
  const read = row(connectors), rows = read.results, items = row(parameters).items;
  if (read.status !== "Ok" || read.requestedCount !== created.length || read.scannedElementCount !== created.length
    || read.failedElementCount !== 0 || read.matchedElementCount !== created.length
    || read.connectorScanTruncatedElementCount !== 0 || read.openPhysicalConnectorCount !== 1
    || !Array.isArray(rows) || !sameIds(rows.map((value: unknown) => row(value).id), created)
    || !Array.isArray(items) || !sameIds(items.map((value: unknown) => row(value).id), created)) return false;
  const byId = new Map<number, Row>(rows.map((value: unknown) => [row(value).id, row(value)]));
  const paramById = new Map<number, Row>(items.map((value: unknown) => [row(value).id, row(row(value).parameters)]));
  const ductIds = [splitIds.find((value: number) => value !== branch.mainElementId)!, ...branchIds];
  const fittingSet = new Set<number>(fittingIds);
  const expectedSystem = token(system.name);
  if (ductIds.some(value => {
    const duct = byId.get(value), p = paramById.get(value);
    return !duct || !p || duct.category !== "OST_DuctCurves" || duct.typeId !== type.id
      || duct.connectorCount !== 2 || duct.returnedConnectorCount !== 2
      || token(p["System Classification"]) !== expectedSystem || Number(p["Reference Level"]) !== level.id
      || !near(p.Diameter, size, 1/192);
  })) return false;
  if (fittingIds.some((value: number) => {
    const fitting = byId.get(value), p = paramById.get(value);
    return !fitting || !p || fitting.category !== "OST_DuctFitting" || token(p["System Classification"]) !== expectedSystem;
  })) return false;
  const farId = branchIds[branchIds.length-1]!, farPoint = row(branch.branchPoints[branch.branchPoints.length-1]);
  let openCount = 0;
  for (const [elementId, element] of byId) {
    if (element.ok !== true || element.connectorScanTruncated !== false || !Array.isArray(element.connectors)
      || element.connectors.length !== element.connectorCount) return false;
    for (const raw of element.connectors) {
      const connector = row(raw), refs = connector.physicalConnectedTo;
      if (connector.domain !== "DomainHvac" || connector.shape !== "Round"
        || token(connector.systemClassification) !== expectedSystem || !near(row(connector.size).diameterFt, size, 1/192)
        || !Array.isArray(refs) || refs.length > 1) return false;
      if (refs.length === 0) {
        openCount++;
        if (elementId !== farId || !Array.isArray(connector.origin)
          || !["x","y","z"].every((axis,index) => near(connector.origin[index], farPoint[axis], 0.02))) return false;
      } else {
        const ref = row(refs[0]);
        if (ref.isPhysicalElement !== true || !id(ref.ownerId)) return false;
        if (byId.has(ref.ownerId)) {
          const peer = byId.get(ref.ownerId)!;
          if (!peer.connectors.some((value: unknown) => row(value).physicalConnectedTo?.some((link: unknown) => row(link).ownerId === elementId))) return false;
        }
      }
    }
  }
  if (openCount !== 1) return false;
  const tee = byId.get(fittingIds[0]);
  const splitNewId = splitIds.find((value: number) => value !== branch.mainElementId)!;
  if (!tee || tee.connectorCount !== 3 || !sameIds(tee.connectors.flatMap((value: unknown) => row(value).physicalConnectedTo?.map((ref: unknown) => row(ref).ownerId) ?? []),
    [branch.mainElementId, splitNewId, branchIds[0]!])) return false;
  for (let index = 0; index < branchIds.length; index++) {
    const duct = byId.get(branchIds[index]!)!;
    const plannedA = row(branch.branchPoints[index]), plannedB = row(branch.branchPoints[index+1]);
    const direction = [plannedB.x-plannedA.x, plannedB.y-plannedA.y, plannedB.z-plannedA.z];
    const lengthSq = direction.reduce((sum: number, value: number) => sum + value*value, 0);
    if (lengthSq < 0.01) return false;
    for (const connector of duct.connectors) {
      const origin = row(connector).origin;
      if (!Array.isArray(origin) || origin.length !== 3) return false;
      const delta = origin.map((value: number, i: number) => value-plannedA[["x","y","z"][i]]);
      const fraction = delta.reduce((sum: number, value: number, i: number) => sum + value*direction[i], 0)/lengthSq;
      const miss = Math.hypot(...delta.map((value: number,i: number) => value-fraction*direction[i]));
      if (miss > 0.05 || fraction < -0.02 || fraction > 1.02) return false;
    }
  }
  return fittingSet.size === fittingIds.length && row(row(result.connectedNetworkAudit).systemAudit).pass === true;
}
