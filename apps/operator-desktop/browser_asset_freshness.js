import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// A release-instance identity, not an authentication credential. Native harness
// requests without browser headers keep their existing admission contracts.
export function createBrowserAssetFreshness(publicRoot) {
  const instance = randomBytes(24).toString('hex');
  function snapshot() {
    const hash = createHash('sha256').update(instance);
    let entry;
    function visit(directory) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) visit(filename);
        else if (/\.(?:m?js|css|html)$/.test(item.name)) {
          const bytes = fs.readFileSync(filename);
          hash.update(path.relative(publicRoot, filename)).update('\0').update(bytes).update('\0');
          if (filename === path.join(publicRoot, 'app.js')) entry = bytes.toString('utf8');
        }
      }
    }
    visit(publicRoot);
    if (entry === undefined) throw new Error('Browser entry asset unavailable.');
    return { identity: hash.digest('hex'), entry };
  }
  const workPaths = new Set(['/api/chat', '/api/chat/stream', '/api/computer/run', '/api/computer/interject', '/api/assignment-workspace/v2/steer']);
  return {
    snapshot,
    middleware(req, res, next) {
      if (req.method === 'GET' && req.path === '/app.js') {
        const current = snapshot();
        res.setHeader('Cache-Control', 'no-store');
        return res.type('application/javascript; charset=utf-8').end(`const LOADED_BROWSER_ASSET_IDENTITY = ${JSON.stringify(current.identity)};\n${current.entry}`);
      }
      if (req.method === 'GET' && req.path === '/api/browser-asset-identity') {
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ identity: snapshot().identity });
      }
      // Pause/stop/cancel/recovery remain available from an old page. Resume admits new work.
      const startsWork = workPaths.has(req.path) || (req.path === '/api/assignment-workspace/v2/control' && req.body?.action === 'resume');
      if (req.method === 'POST' && startsWork
          && (req.get('origin') || req.get('sec-fetch-site') || req.get('x-operator-browser-identity'))) {
        if (req.get('x-operator-browser-identity') !== snapshot().identity) {
          return res.status(409).json({ ok: false, code: 'SIDECAR_BROWSER_STALE',
            error: 'Operator was updated. Your draft is preserved. Refresh this page before sending; the current task will not be restarted.',
            request_dispatched: false, outcome_unknown: false, retryable: false, reconciliation_required: false });
        }
      }
      return next();
    }
  };
}
