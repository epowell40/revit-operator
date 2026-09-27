import { createMepRouteReadbackMatchesV2 } from './polyline_readback_v2.js';

type Row = Record<string, any>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sameIds = (actual: unknown, expected: number[]): boolean => Array.isArray(actual)
  && actual.length === expected.length && actual.every(id)
  && new Set(actual).size === actual.length && actual.every(value => expected.includes(value));

/** Bound one registered native stage to its embedded route and independent
 * post-commit connector graph. Multi-action stages need a separate proof. */
export function registeredStageDuctRouteInputV2(input: unknown): boolean {
  const request = row(input), body = row(request.body);
  if (request.method !== 'POST' || request.path !== '/revit/existing-conditions-mep-draft-workflow'
    || body.dryRun !== false || body.verify !== true || typeof body.stageKey !== 'string'
    || !body.stageKey.startsWith('operation:') || !Array.isArray(body.priorActionOutputs)
    || body.priorActionOutputs.length !== 0 || !Array.isArray(body.operations) || body.operations.length !== 1
    || !id(body.maximumCreatedElements) || body.maximumCreatedElements > 64) return false;
  const action = row(body.operations[0]), route = row(action.apply_body);
  return action.path === '/revit/create-mep-route' && typeof action.action_key === 'string'
    && body.stageKey === `operation:${action.action_key}` && Array.isArray(action.depends_on)
    && action.depends_on.length === 0 && id(action.expected_created_min)
    && id(action.expected_created_max) && action.expected_created_min <= action.expected_created_max
    && action.expected_created_max <= body.maximumCreatedElements
    && route.kind === 'duct' && route.verify === true && route.connectSegments === true
    && !Object.hasOwn(route, 'dryRun') && !Object.hasOwn(route, 'apply');
}

export function registeredStageDuctRouteReadbackMatchesV2(input: unknown, affected: readonly string[],
  nativeApply: unknown, parameters: unknown, connectors: unknown): boolean {
  if (!registeredStageDuctRouteInputV2(input)) return false;
  const body = row(row(input).body), action = row(body.operations[0]), native = row(nativeApply);
  if (native.schema !== 'operator.existing_conditions_mep_draft_workflow.v1'
    || native.inputFingerprintSha256 !== body.inputFingerprintSha256 || native.stageKey !== body.stageKey
    || native.status !== 'Applied' || native.dryRun !== false || native.transactionGroupRolledBack !== false
    || native.rollbackVerified !== true || native.atomic !== true || native.error != null
    || native.failedOperation != null || native.operationCount !== 1 || native.priorActionOutputCount !== 0
    || !Array.isArray(native.operations) || native.operations.length !== 1
    || !Array.isArray(native.createdElementIds) || native.createdElementIds.length < action.expected_created_min
    || native.createdElementIds.length > action.expected_created_max
    || native.createdElementIds.length > body.maximumCreatedElements
    || !sameIds(native.createdElementIds, affected.map(value => /^element_id:[1-9][0-9]*$/.test(value)
      ? Number(value.slice('element_id:'.length)) : NaN))) return false;
  const result = row(native.operations[0]), routeResult = row(result.response);
  if (result.actionKey !== action.action_key || result.path !== action.path
    || !sameIds(result.createdElementIds, native.createdElementIds)
    || routeResult.dryRun !== false || row(routeResult.transaction).status !== 'committed'
    || row(routeResult.transaction).committed !== true
    || !Array.isArray(routeResult.createdElementIds) || !Array.isArray(routeResult.createdFittingIds)
    || !sameIds([...routeResult.createdElementIds, ...routeResult.createdFittingIds], native.createdElementIds)) return false;
  const route = row(action.apply_body);
  const systemType = ({ SupplyAir: 'Supply Air', 'Supply Air': 'Supply Air',
    ReturnAir: 'Return Air', 'Return Air': 'Return Air',
    ExhaustAir: 'Exhaust Air', 'Exhaust Air': 'Exhaust Air' } as Row)[route.systemType];
  if (!systemType) return false;
  const nested = { method: 'POST', path: '/revit/create-mep-route', body: { ...route, systemType, dryRun: false } };
  return createMepRouteReadbackMatchesV2(nested, routeResult, parameters, connectors);
}
