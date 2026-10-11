type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const same = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
// The create-filter tool accepts one rule. A compound rule with extra predicates
// is not equivalent merely because one matching rule can be found somewhere.
function atom(value: unknown, depth = 0, inverted = false): { rule: Row; inverted: boolean } | null {
  if (depth > 8) return null;
  const n = row(value);
  if (n.kind === 'not') return atom(n.child, depth + 1, !inverted);
  if (n.kind === 'and' && Array.isArray(n.children) && n.children.length === 1 && typeof n.inverted === 'boolean')
    return atom(n.children[0], depth + 1, inverted !== n.inverted);
  return n.kind === 'rule' ? { rule: n, inverted } : null;
}
export function createdViewFilterSatisfiedV2(request: Row, payload: unknown): boolean {
  const root = row(payload), view = row(root.view);
  if (root.status !== 'Ok' || root.action !== 'get' || root.dryRun !== false || root.error || root.isError === true || root.ok === false || root.success === false) return false;
  if (typeof request.viewId !== 'number' || view.id !== request.viewId || request.dryRun === true || !Array.isArray(view.viewFilters)) return false;
  const filters = view.viewFilters.map(row).filter(f => f.name === request.filterName);
  if (filters.length !== 1) return false;
  const filter = filters[0]!, definition = row(filter.definition);
  if (definition.complete !== true || !Array.isArray(definition.categories) || !Array.isArray(definition.categoryIds)) return false;
  const requested = [...new Set([...(request.categoryName == null ? [] : [request.categoryName]), ...(Array.isArray(request.categoryNames) ? request.categoryNames : [])].map(v => typeof v === 'string' ? v.trim().toLowerCase() : ''))];
  const categories = definition.categories.map(row);
  const ids = definition.categoryIds;
  if (!requested.length || requested.includes('') || categories.length !== requested.length || new Set(categories.map(c => c.id)).size !== categories.length
    || ids.length !== categories.length || categories.some(c => !ids.includes(c.id))) return false;
  if (!requested.every(name => categories.some(c => same(c.name, name) || same(c.builtInCategory, name)))) return false;
  const parsed = atom(definition.rules);
  if (!parsed || ![parsed.rule.parameterName, parsed.rule.builtInParameter].some(name => same(name, request.ruleParameterName))) return false;
  const op = String(request.ruleOperator ?? 'contains').trim().toLowerCase().replace(/[- ]/g, '_') || 'contains';
  const evaluators: Record<string, string[]> = {
    equals: ['FilterStringEquals', 'FilterNumericEquals'], not_equals: ['FilterStringEquals', 'FilterNumericEquals'],
    contains: ['FilterStringContains'], not_contains: ['FilterStringContains'], begins_with: ['FilterStringBeginsWith'], ends_with: ['FilterStringEndsWith'],
    greater: ['FilterNumericGreater'], greater_or_equal: ['FilterNumericGreaterOrEqual'], less: ['FilterNumericLess'], less_or_equal: ['FilterNumericLessOrEqual'],
  };
  if (!evaluators[op]?.includes(String(parsed.rule.evaluator)) || parsed.inverted !== (op === 'not_equals' || op === 'not_contains')) return false;
  const expected = String(request.ruleValue ?? '').trim();
  if (parsed.rule.valueType === 'string') {
    if (!String(parsed.rule.evaluator).startsWith('FilterString') || !expected || parsed.rule.value !== expected || request.ruleCaseSensitive === true) return false;
  } else {
    // Creation supports Int32 and positive ElementId values, not Double rules.
    // Reading a stored Double is useful evidence but cannot certify this tool.
    if (!['integer', 'element_id'].includes(String(parsed.rule.valueType)) || !String(parsed.rule.evaluator).startsWith('FilterNumeric')
      || !/^[+-]?\d+$/.test(expected) || !Number.isSafeInteger(Number(expected)) || parsed.rule.value !== Number(expected)) return false;
    if (parsed.rule.valueType === 'integer' && (Number(expected) < -2147483648 || Number(expected) > 2147483647)) return false;
    if (parsed.rule.valueType === 'element_id' && (Number(expected) <= 0 || !['equals', 'not_equals'].includes(op))) return false;
  }
  const override = row(filter.override);
  for (const key of ['lineWeight', 'linePatternId']) if (request[key] != null && override[key] !== request[key]) return false;
  for (const channel of ['r', 'g', 'b']) if (request[channel] != null && row(override.color)[channel] !== request[channel]) return false;
  if (request.filterVisible != null && filter.visible !== request.filterVisible) return false;
  return true;
}
