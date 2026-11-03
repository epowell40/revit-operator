import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { storeEvidence } from '../src/evidence/evidence_store.js';
import { modelEvidenceEnvelope } from '../src/evidence/model_context_budget.js';
import { __closeForTests } from '../src/memory/sqlite_store.js';

const manifest = fs.readFileSync('../revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs', 'utf8');
function description(route: string) {
  const line = manifest.split(/\r?\n/).find(line => line.includes(`"${route}"`));
  assert(line, route);
  const match = line.match(/OperatorActionRisk\.\w+,\s*("(?:[^"\\]|\\.)*")/);
  assert(match, route);
  return JSON.parse(match[1]!) as string;
}
const scope = { session_id: 'native-guidance', assignment_id: 'assignment-guidance', run_id: 'run-guidance', attempt_id: 'read-guidance', generation: 1 };

test('native discovery read versus write guidance reaches model context through inline and projected tool documentation', () => {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-guidance-'));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    for (const route of ['/revit/native-api-call', '/revit/native-api-search', '/revit/native-api-catalog']) {
      const prose = description(route);
      assert(prose.includes('Read-only instance or object-reference chains use native-api-ops'));
      assert(!prose.includes('Graph-only native-object references and detached solid construction require native-api-mutation-ops'));
      for (const large of [false, true]) {
        const doc = { version: 'operator.tool_doc.v1', method: 'POST', path: route, risk: route.endsWith('-call') ? 'medium' : 'low', title: 'Native discovery',
          description: prose, required_fields: route.endsWith('-call') ? ['memberId'] : route.endsWith('-search') ? ['query'] : [], request_schema: { type: 'object' }, optional_fields: [],
          notes: [], examples: large ? ['unrelated example '.repeat(3000)] : [] };
        const raw = { content: [{ type: 'text', text: JSON.stringify(doc) }] };
        const saved = storeEvidence({ scope, source: 'assignment_kernel_v2:revit_tool_doc', trust_level: 'host_observed', raw }, 8192);
        const wire = modelEvidenceEnvelope([saved.projection], 0);
        const visible = JSON.stringify(wire);
        assert(visible.includes(prose));
        assert.equal(saved.projection.effect_state, null);
        assert.equal(saved.projection.trust_level, 'host_observed');
        if (large) assert.equal(saved.projection.tool_documentation?.completion_eligible, false);
      }
    }
  } finally {
    __closeForTests();
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
