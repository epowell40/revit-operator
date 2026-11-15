import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCodexHomeAuth, prepareCertifiedCodexIsolation } from '../src/codex/config.js';

test('explicit installation key is used, rotates, and cannot fall back to desktop credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-explicit-auth-'));
  const previous = process.env.OPERATOR_CODEX_AUTH_FILE;
  try {
    const source = path.join(root, 'source.json');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'unrelated-test-token' } }));
    process.env.OPERATOR_CODEX_AUTH_FILE = source;
    for (const key of ['test-key-one', 'test-key-two']) {
      fs.writeFileSync(source, JSON.stringify({ OPENAI_API_KEY: key }));
      ensureCodexHomeAuth({ codexHome: home });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')), { OPENAI_API_KEY: key });
    }
    const isolated = prepareCertifiedCodexIsolation({ workspaceRoot: root, isolationRoot: path.join(root, 'isolated') });
    assert.equal(JSON.parse(fs.readFileSync(path.join(isolated.codexHome, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'test-key-two');
    const retained = fs.readFileSync(path.join(home, 'auth.json'), 'utf8');
    for (const invalid of ['not-json', '{}', '{"OPENAI_API_KEY":""}', '{"OPENAI_API_KEY":42}']) {
      fs.writeFileSync(source, invalid);
      assert.throws(() => ensureCodexHomeAuth({ codexHome: home }), /missing or invalid/);
      assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), retained);
    }
    fs.unlinkSync(source);
    assert.throws(() => ensureCodexHomeAuth({ codexHome: home }), /missing or invalid/);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_CODEX_AUTH_FILE;
    else process.env.OPERATOR_CODEX_AUTH_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
