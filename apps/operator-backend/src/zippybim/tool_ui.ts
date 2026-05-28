function escapeForJs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

export function buildZippyBimToolHtml(defaultScaleRatio: number): string {
  const defaultScale = Number.isFinite(defaultScaleRatio) && defaultScaleRatio > 0 ? defaultScaleRatio : 0.010416666;
  const maxApplyElementsPerBatch = 4000;
  const maxApplyCharsPerBatch = 1_400_000;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Floor Plan Import</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f5f1e8;
        --bg-2: #efe5d4;
        --ink: #1f2022;
        --line: rgba(39, 40, 43, 0.18);
        --accent: #9a4b24;
        --accent-2: #194f5f;
        --ok: #2d6c4e;
        --warn: #9a5b14;
        --err: #9c3030;
        --card: rgba(255,255,255,0.68);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #18191c;
          --bg-2: #222327;
          --ink: #f3efe7;
          --line: rgba(255,255,255,0.12);
          --card: rgba(255,255,255,0.04);
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.45 "Segoe UI", system-ui, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(154,75,36,0.16), transparent 28%),
          radial-gradient(circle at top right, rgba(25,79,95,0.18), transparent 26%),
          linear-gradient(180deg, var(--bg), var(--bg-2));
      }
      .page {
        min-height: 100vh;
        display: grid;
        gap: 16px;
        padding: 18px;
        align-content: start;
      }
      .hero {
        display: grid;
        gap: 6px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
        opacity: 0.72;
      }
      h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.05;
      }
      .sub {
        max-width: 78ch;
        opacity: 0.86;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(300px, 370px) minmax(320px, 1fr);
        gap: 16px;
      }
      .stack {
        display: grid;
        gap: 16px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--card);
        backdrop-filter: blur(10px);
        box-shadow: 0 8px 30px rgba(0,0,0,0.08);
        overflow: hidden;
      }
      .card > .hd {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid var(--line);
      }
      .card > .bd {
        padding: 14px 16px 16px;
        display: grid;
        gap: 14px;
      }
      h2 {
        margin: 0;
        font-size: 16px;
      }
      label {
        display: grid;
        gap: 6px;
        font-weight: 600;
      }
      input, select, button, textarea {
        font: inherit;
      }
      input, select {
        width: 100%;
        min-width: 0;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.55);
        color: inherit;
      }
      @media (prefers-color-scheme: dark) {
        input, select {
          background: rgba(0,0,0,0.25);
        }
      }
      .grid2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }
      button {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 10px 14px;
        background: rgba(255,255,255,0.35);
        color: inherit;
        cursor: pointer;
      }
      button.primary {
        background: linear-gradient(135deg, var(--accent), #c87833);
        color: #fff;
        border-color: transparent;
      }
      button.secondary {
        background: linear-gradient(135deg, var(--accent-2), #32758b);
        color: #fff;
        border-color: transparent;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .note {
        font-size: 12px;
        opacity: 0.78;
      }
      .status {
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.24);
      }
      .status.ok { border-color: rgba(45,108,78,0.35); color: var(--ok); }
      .status.warn { border-color: rgba(154,91,20,0.35); color: var(--warn); }
      .status.err { border-color: rgba(156,48,48,0.35); color: var(--err); }
      .job-list, .warnings {
        display: grid;
        gap: 8px;
      }
      .job {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.16);
        cursor: pointer;
      }
      .job:hover { background: rgba(255,255,255,0.26); }
      .job.active { outline: 2px solid rgba(154,75,36,0.3); }
      .job .meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 12px;
        opacity: 0.78;
      }
      .counts {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      .count {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        text-align: center;
        background: rgba(255,255,255,0.16);
      }
      .count strong {
        display: block;
        font-size: 24px;
        line-height: 1;
      }
      .preview-wrap {
        display: grid;
        gap: 10px;
      }
      .preview {
        width: 100%;
        max-height: 62vh;
        object-fit: contain;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(0,0,0,0.08);
      }
      .pdfPreview {
        width: 100%;
        min-height: 340px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.48);
      }
      details.advanced {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,255,255,0.16);
        padding: 10px 12px;
      }
      details.advanced summary {
        cursor: pointer;
        font-weight: 600;
      }
      pre {
        margin: 0;
        min-height: 120px;
        max-height: 220px;
        overflow: auto;
        border-radius: 12px;
        border: 1px solid var(--line);
        padding: 12px;
        background: rgba(0,0,0,0.06);
        font: 12px/1.4 Consolas, monospace;
        white-space: pre-wrap;
      }
      .hidden { display: none !important; }
      @media (max-width: 980px) {
        .layout { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="hero">
        <div class="eyebrow">Operator Tool</div>
        <h1>Floor Plan Import</h1>
        <div class="sub">Run ZippyBIM remotely against a PDF, keep Revit responsive while it works, then apply the resulting walls locally when you are ready.</div>
      </div>

      <div class="layout">
        <div class="stack">
          <section class="card">
            <div class="hd">
              <h2>Source PDF</h2>
              <div class="toolbar">
                <button id="btnToggleSourceScope">Workspace PDFs</button>
                <button id="btnRefreshSources">Refresh</button>
              </div>
            </div>
            <div class="bd">
              <label>
                PDF
                <select id="sourceSelect"></select>
              </label>
              <label>
                Drawing Scale
                <select id="drawingScale"></select>
              </label>
              <label>
                Extraction Engine
                <select id="extractorSelect">
                  <option value="zippybim" selected>ZippyBIM Remote</option>
                  <option value="gemini">Gemini Vision (Experimental)</option>
                </select>
              </label>
              <label>
                Detect Doors
                <select id="detectDoors">
                  <option value="false" selected>Off</option>
                  <option value="true">On (Beta)</option>
                </select>
              </label>
              <label>
                Place Vector Underlay with Walls
                <select id="placeUnderlayWithWalls">
                  <option value="true" selected>On</option>
                  <option value="false">Off</option>
                </select>
              </label>
              <details class="advanced">
                <summary>Advanced Crop / Ratio</summary>
                <div class="bd" style="padding:12px 0 0;">
                  <label>
                    Scale Ratio
                    <input id="scaleRatio" type="number" step="0.000001" value="${escapeForJs(String(defaultScale))}" />
                  </label>
                  <div class="grid2">
                    <label>
                      Crop Min X
                      <input id="cropMinX" type="number" step="0.01" value="0" />
                    </label>
                    <label>
                      Crop Min Y
                      <input id="cropMinY" type="number" step="0.01" value="0" />
                    </label>
                  </div>
                  <label>
                    Crop Max Y
                    <input id="cropMaxY" type="number" step="0.01" value="100" />
                  </label>
                </div>
              </details>
              <div class="actions">
                <button class="primary" id="btnStart">Start Prediction</button>
                <button id="btnClose">Close</button>
              </div>
              <div class="note" id="sourceNote">The picker will prefer PDFs attached in this chat.</div>
            </div>
          </section>

          <section class="card">
            <div class="hd">
              <h2>Recent Jobs</h2>
            </div>
            <div class="bd">
              <div id="jobs" class="job-list"></div>
            </div>
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <div class="hd">
              <h2>Status</h2>
            </div>
            <div class="bd">
              <div id="health" class="status">Checking remote service…</div>
              <div id="jobStatus" class="status">No active prediction job.</div>
              <div class="counts hidden" id="counts">
                <div class="count"><strong id="wallCount">0</strong><span>Walls</span></div>
                <div class="count"><strong id="doorCount">0</strong><span>Doors</span></div>
                <div class="count"><strong id="segmentCount">0</strong><span>Raw Segments</span></div>
              </div>
              <div class="actions">
                <button class="secondary" id="btnApplyWalls" disabled>Apply Walls</button>
                <button id="btnPlaceUnderlay" disabled>Place Vector Underlay</button>
              </div>
              <div id="warningsWrap" class="hidden">
                <strong>Warnings</strong>
                <div id="warnings" class="warnings"></div>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="hd">
              <h2>Preview</h2>
            </div>
            <div class="bd">
              <div class="preview-wrap">
                <iframe id="sourcePreview" class="pdfPreview hidden" title="Source PDF preview"></iframe>
                <img id="previewImage" class="preview hidden" alt="Prediction preview" />
                <pre id="resultDump">No result loaded.</pre>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>

    <script>
      const host = () => window.OperatorToolHost || null;
      const state = {
        initPayload: {},
        health: null,
        sessionSources: [],
        workspaceSources: [],
        showWorkspaceSources: false,
        jobs: [],
        selectedJobId: null,
        selectedResult: null,
        preferredSourcePath: '',
        selectedSourcePath: '',
        pollTimer: null
      };
      const SCALE_PRESETS = [
        { label: '1" = 1\\'-0"', value: 1 / 12 },
        { label: '3/4" = 1\\'-0"', value: 1 / 16 },
        { label: '1/2" = 1\\'-0"', value: 1 / 24 },
        { label: '1/4" = 1\\'-0"', value: 1 / 48 },
        { label: '1/8" = 1\\'-0"', value: 1 / 96 },
        { label: '3/32" = 1\\'-0"', value: 1 / 128 },
        { label: '1/16" = 1\\'-0"', value: 1 / 192 },
        { label: '1" = 10\\'-0"', value: 1 / 120 },
        { label: '1" = 20\\'-0"', value: 1 / 240 },
        { label: '1" = 30\\'-0"', value: 1 / 360 }
      ];

      const els = {
        sourceSelect: document.getElementById('sourceSelect'),
        drawingScale: document.getElementById('drawingScale'),
        extractorSelect: document.getElementById('extractorSelect'),
        scaleRatio: document.getElementById('scaleRatio'),
        detectDoors: document.getElementById('detectDoors'),
        placeUnderlayWithWalls: document.getElementById('placeUnderlayWithWalls'),
        cropMinX: document.getElementById('cropMinX'),
        cropMinY: document.getElementById('cropMinY'),
        cropMaxY: document.getElementById('cropMaxY'),
        btnToggleSourceScope: document.getElementById('btnToggleSourceScope'),
        btnRefreshSources: document.getElementById('btnRefreshSources'),
        btnStart: document.getElementById('btnStart'),
        btnClose: document.getElementById('btnClose'),
        btnApplyWalls: document.getElementById('btnApplyWalls'),
        btnPlaceUnderlay: document.getElementById('btnPlaceUnderlay'),
        health: document.getElementById('health'),
        jobStatus: document.getElementById('jobStatus'),
        jobs: document.getElementById('jobs'),
        sourcePreview: document.getElementById('sourcePreview'),
        previewImage: document.getElementById('previewImage'),
        resultDump: document.getElementById('resultDump'),
        counts: document.getElementById('counts'),
        wallCount: document.getElementById('wallCount'),
        doorCount: document.getElementById('doorCount'),
        segmentCount: document.getElementById('segmentCount'),
        warningsWrap: document.getElementById('warningsWrap'),
        warnings: document.getElementById('warnings'),
        sourceNote: document.getElementById('sourceNote')
      };
      let bootstrapPromise = null;

      function setStatus(el, tone, text) {
        el.className = 'status' + (tone ? ' ' + tone : '');
        el.textContent = text;
      }

      function errorText(err, fallback) {
        if (err && typeof err.message === 'string' && err.message.trim()) return err.message.trim();
        if (typeof err === 'string' && err.trim()) return err.trim();
        return fallback;
      }

      function pretty(value) {
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      }

      function fileStem(name) {
        const text = String(name || '').trim();
        return text.replace(/\\.[^.]+$/, '') || 'Floor Plan';
      }

      function normalizePath(path) {
        return String(path || '').trim().replace(/\\\\/g, '/');
      }

      function currentExtractor() {
        return String(els.extractorSelect.value || 'zippybim').trim().toLowerCase() === 'gemini' ? 'gemini' : 'zippybim';
      }

      function extractorLabel(value) {
        return String(value || '').trim().toLowerCase() === 'gemini' ? 'Gemini Vision' : 'ZippyBIM Remote';
      }

      function approxEqual(a, b) {
        return Math.abs(Number(a) - Number(b)) < 0.0000005;
      }

      function visibleSources() {
        if (!state.showWorkspaceSources && state.sessionSources.length) return state.sessionSources;
        return dedupeSources([...(state.sessionSources || []), ...(state.workspaceSources || [])]);
      }

      function dedupeSources(items) {
        const map = new Map();
        for (const item of items || []) {
          if (!item) continue;
          const relative_path = normalizePath(item.relative_path || item.relativePath);
          if (!relative_path || !/\\.pdf$/i.test(relative_path)) continue;
          const existing = map.get(relative_path.toLowerCase());
          const next = {
            relative_path,
            filename: item.filename || item.file_name || relative_path.split('/').pop(),
            bytes: Number(item.bytes || 0) || 0,
            modified_at: item.modified_at || item.created_at || item.createdAt || '',
            source: item.source || 'attachments'
          };
          if (!existing || String(existing.modified_at || '') < String(next.modified_at || '')) {
            map.set(relative_path.toLowerCase(), next);
          }
        }
        return Array.from(map.values()).sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
      }

      function populateScalePresets() {
        els.drawingScale.innerHTML = '';
        SCALE_PRESETS.forEach(item => {
          const option = document.createElement('option');
          option.value = String(item.value);
          option.textContent = item.label;
          els.drawingScale.appendChild(option);
        });
        const custom = document.createElement('option');
        custom.value = 'custom';
        custom.textContent = 'Custom ratio';
        els.drawingScale.appendChild(custom);
      }

      function syncScalePresetFromRatio() {
        const ratio = Number(els.scaleRatio.value || '0');
        const match = SCALE_PRESETS.find(item => approxEqual(item.value, ratio));
        els.drawingScale.value = match ? String(match.value) : 'custom';
      }

      async function loadSourcePreview() {
        const relative_path = normalizePath(els.sourceSelect.value || state.selectedSourcePath);
        state.selectedSourcePath = relative_path;
        if (!relative_path) {
          els.sourcePreview.removeAttribute('src');
          els.sourcePreview.classList.add('hidden');
          return;
        }
        try {
          const preview = await backendRequest('GET', '/tools/zippybim/source-preview?relative_path=' + encodeURIComponent(relative_path));
          if (preview && preview.ok && preview.download_url) {
            els.sourcePreview.src = String(preview.download_url);
            els.sourcePreview.classList.remove('hidden');
            return;
          }
        } catch {}
        els.sourcePreview.removeAttribute('src');
        els.sourcePreview.classList.add('hidden');
      }

      async function getSourceAccess(relativePath) {
        return backendRequest('GET', '/tools/zippybim/source-preview?relative_path=' + encodeURIComponent(relativePath));
      }

      async function backendRequest(method, path, body) {
        return host().request('backend.request', Object.assign({ method, path }, body === undefined ? {} : { body }));
      }

      async function revitAction(path, body) {
        return host().request('revit.executeAction', { method: 'POST', path, body: body || {} });
      }

      function renderSources() {
        const current = normalizePath(state.selectedSourcePath || els.sourceSelect.value);
        const preferred = normalizePath(state.preferredSourcePath);
        const items = visibleSources();
        els.sourceSelect.innerHTML = '';
        if (!items.length) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = 'No PDFs found';
          els.sourceSelect.appendChild(option);
          els.btnStart.disabled = true;
          els.sourceNote.textContent = 'Attach a PDF in Operator first, or export a PDF into the workspace, then refresh.';
          els.btnToggleSourceScope.disabled = true;
          return;
        }

        items.forEach(item => {
          const option = document.createElement('option');
          option.value = item.relative_path;
          option.textContent = item.filename + ' [' + item.source + ']';
          if (item.relative_path === current) option.selected = true;
          else if (!current && preferred && item.relative_path === preferred) option.selected = true;
          els.sourceSelect.appendChild(option);
        });
        if (!items.some(item => item.relative_path === normalizePath(els.sourceSelect.value))) {
          const preferredIndex = preferred ? items.findIndex(item => item.relative_path === preferred) : -1;
          els.sourceSelect.selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
        }
        state.selectedSourcePath = normalizePath(els.sourceSelect.value);
        els.btnStart.disabled = false;
        els.btnToggleSourceScope.disabled = state.sessionSources.length === 0;
        els.btnToggleSourceScope.textContent = state.showWorkspaceSources ? 'Attached PDFs' : 'Workspace PDFs';
        if (!state.showWorkspaceSources && state.sessionSources.length) {
          const selected = items.find(item => item.relative_path === state.selectedSourcePath);
          const selectedName = selected && selected.filename ? selected.filename : state.initPayload.preferred_filename;
          els.sourceNote.textContent = selectedName
            ? 'Showing PDFs attached in this chat. Preselected: ' + selectedName + '. Switch to Workspace PDFs if you need an older file.'
            : 'Showing PDFs attached in this chat. Switch to Workspace PDFs if you need an older file.';
        } else {
          els.sourceNote.textContent = 'Showing PDFs from the Operator workspace. Revit only touches the result when you click Apply Walls.';
        }
        void loadSourcePreview();
      }

      function renderJobs() {
        els.jobs.innerHTML = '';
        if (!state.jobs.length) {
          const div = document.createElement('div');
          div.className = 'note';
          div.textContent = 'No jobs yet.';
          els.jobs.appendChild(div);
          return;
        }

        state.jobs.forEach(job => {
          const extractor = job && job.params ? extractorLabel(job.params.extractor) : 'ZippyBIM Remote';
          const div = document.createElement('div');
          div.className = 'job' + (job.id === state.selectedJobId ? ' active' : '');
          const title = document.createElement('strong');
          title.textContent = job.source_filename || job.source_relative_path || job.id;
          const meta = document.createElement('div');
          meta.className = 'meta';
          const left = document.createElement('span');
          left.textContent = extractor + ' · ' + (job.status || 'queued');
          const right = document.createElement('span');
          right.textContent = (job.created_at || '').replace('T', ' ').replace('Z', '');
          meta.appendChild(left);
          meta.appendChild(right);
          div.appendChild(title);
          div.appendChild(meta);
          div.addEventListener('click', () => selectJob(job.id));
          els.jobs.appendChild(div);
        });
      }

      function renderResult() {
        const result = state.selectedResult;
        const summary = result && result.summary ? result.summary : null;
        const metadata = result && result.geometry ? result.geometry.metadata || {} : {};
        const preview = metadata && metadata.raster_image ? 'data:image/png;base64,' + metadata.raster_image : '';

        if (preview) {
          els.previewImage.src = preview;
          els.previewImage.classList.remove('hidden');
        } else {
          els.previewImage.removeAttribute('src');
          els.previewImage.classList.add('hidden');
        }

        if (summary) {
          els.counts.classList.remove('hidden');
          els.wallCount.textContent = String(summary.wall_count || 0);
          els.doorCount.textContent = String(summary.door_count || 0);
          els.segmentCount.textContent = String(summary.raw_segment_count || 0);
        } else {
          els.counts.classList.add('hidden');
        }

        const warnings = summary && Array.isArray(summary.warnings) ? summary.warnings.filter(Boolean) : [];
        els.warnings.innerHTML = '';
        if (warnings.length) {
          els.warningsWrap.classList.remove('hidden');
          warnings.forEach(text => {
            const item = document.createElement('div');
            item.className = 'status warn';
            item.textContent = text;
            els.warnings.appendChild(item);
          });
        } else {
          els.warningsWrap.classList.add('hidden');
        }

        els.resultDump.textContent = result ? pretty({
          source_relative_path: result.source_relative_path,
          summary: result.summary,
          metadata: Object.assign({}, metadata, metadata && metadata.raster_image ? { raster_image: '<omitted>' } : {})
        }) : 'No result loaded.';

        const canApply = !!(result && result.geometry && Array.isArray(result.geometry.elements) && result.geometry.elements.some(x => x && x.element === 'wall'));
        els.btnApplyWalls.disabled = !canApply;
        els.btnPlaceUnderlay.disabled = !canCreateVectorUnderlay(result);
      }

      function stripGeometryForApply(result) {
        if (!result || !result.geometry) return null;
        const metadata = Object.assign({}, result.geometry.metadata || {});
        delete metadata.raster_image;
        const minimalElements = Array.isArray(result.geometry.elements)
          ? result.geometry.elements
            .filter(item => item && (item.element === 'wall' || item.element === 'door' || item.element === 'raw_segment'))
            .map(item => {
              if (item.element === 'wall') {
                return {
                  id: item.id || null,
                  element: 'wall',
                  path: Array.isArray(item.path) ? item.path : [],
                  thickness: typeof item.thickness === 'number' ? item.thickness : null,
                  height: typeof item.height === 'number' ? item.height : null
                };
              }
              if (item.element === 'door') {
                return {
                  id: item.id || null,
                  element: 'door',
                  position: Array.isArray(item.position) ? item.position : [],
                  width: typeof item.width === 'number' ? item.width : null
                };
              }
              return {
                id: item.id || null,
                element: 'raw_segment',
                path: Array.isArray(item.path) ? item.path : []
              };
            })
          : [];
        return {
          metadata,
          elements: minimalElements,
          debug: result.geometry.debug || null
        };
      }

      function canCreateVectorUnderlay(result) {
        return !!(result && result.geometry && Array.isArray(result.geometry.elements)
          && result.geometry.elements.some(item => item && item.element === 'raw_segment'));
      }

      function filterGeometryElements(geometry, allowedKinds) {
        return {
          metadata: geometry && geometry.metadata ? Object.assign({}, geometry.metadata) : {},
          elements: geometry && Array.isArray(geometry.elements)
            ? geometry.elements.filter(item => item && allowedKinds.has(item.element))
            : [],
          debug: null
        };
      }

      function chunkElementsForImport(elements) {
        const batches = [];
        let current = [];
        let currentChars = 0;

        for (const item of (Array.isArray(elements) ? elements : [])) {
          if (!item) continue;
          let itemChars = 0;
          try {
            itemChars = JSON.stringify(item).length;
          } catch {
            itemChars = 0;
          }

          const nextCount = current.length + 1;
          const nextChars = currentChars + itemChars;
          if (current.length > 0 && (nextCount > ${maxApplyElementsPerBatch} || nextChars > ${maxApplyCharsPerBatch})) {
            batches.push(current);
            current = [];
            currentChars = 0;
          }

          current.push(item);
          currentChars += itemChars;
        }

        if (current.length > 0) batches.push(current);
        return batches;
      }

      function summarizeImportResult(response) {
        const summary = response && response.summary ? response.summary : {};
        const warnings = Array.isArray(response && response.warnings) ? response.warnings.filter(Boolean) : [];
        return {
          wallsCreated: Number(summary.wallsCreated || 0),
          wallsSkipped: Number(summary.wallsSkipped || 0),
          doorsCreated: Number(summary.doorsCreated || 0),
          doorsSkipped: Number(summary.doorsSkipped || 0),
          vectorUnderlayCreated: Number(summary.vectorUnderlayCreated || 0),
          vectorUnderlaySkipped: Number(summary.vectorUnderlaySkipped || 0),
          warnings
        };
      }

      function mergeImportSummaries(responses) {
        const merged = {
          wallsCreated: 0,
          wallsSkipped: 0,
          doorsCreated: 0,
          doorsSkipped: 0,
          vectorUnderlayCreated: 0,
          vectorUnderlaySkipped: 0,
          warnings: []
        };

        for (const response of (Array.isArray(responses) ? responses : [])) {
          const item = summarizeImportResult(response);
          merged.wallsCreated += item.wallsCreated;
          merged.wallsSkipped += item.wallsSkipped;
          merged.doorsCreated += item.doorsCreated;
          merged.doorsSkipped += item.doorsSkipped;
          merged.vectorUnderlayCreated += item.vectorUnderlayCreated;
          merged.vectorUnderlaySkipped += item.vectorUnderlaySkipped;
          merged.warnings.push(...item.warnings);
        }

        merged.warnings = Array.from(new Set(merged.warnings));
        return merged;
      }

      async function importVectorUnderlayInBatches(sourcePath, geometry, baseRequest, progressPrefix) {
        const underlayGeometry = filterGeometryElements(geometry, new Set(['raw_segment']));
        const batches = chunkElementsForImport(underlayGeometry.elements);
        const responses = [];

        for (let i = 0; i < batches.length; i++) {
          setStatus(els.jobStatus, 'warn', progressPrefix + ' batch ' + (i + 1) + ' of ' + batches.length + '…');
          const response = await revitAction('/revit/import-zippybim-geometry', Object.assign({}, baseRequest, {
            sourcePath,
            geometry: {
              metadata: underlayGeometry.metadata,
              elements: batches[i],
              debug: null
            },
            importWalls: false,
            importVectorUnderlay: true,
            importDoors: false,
            disableWallJoins: true
          }));
          responses.push(response);
        }

        return {
          batches: batches.length,
          responses,
          summary: mergeImportSummaries(responses)
        };
      }

      async function loadHealth() {
        const data = await backendRequest('GET', '/tools/zippybim/health');
        state.health = data;
        const extractors = data && Array.isArray(data.extractors) ? data.extractors : [];
        const selectedExtractor = currentExtractor();
        const selected = extractors.find(item => String(item && item.id || '').toLowerCase() === selectedExtractor) || null;
        if (selectedExtractor === 'gemini') {
          if (selected && selected.ok) {
            setStatus(els.health, 'warn', 'Gemini vision extractor ready. This path is experimental and best for comparison against ZippyBIM.');
            els.detectDoors.disabled = false;
          } else {
            setStatus(els.health, 'err', (selected && selected.error) || 'Gemini vision extractor is not available.');
            els.detectDoors.disabled = true;
            els.detectDoors.value = 'false';
          }
          return;
        }

        const remote = data && data.remote && data.remote.remote ? data.remote.remote : {};
        if (selected && selected.ok) {
          const doorLoaded = remote.door_model_loaded === true;
          const beta = data.door_import_beta_enabled === true;
          let healthText = 'Remote service ready.';
          let healthKind = 'ok';
          if (doorLoaded && beta) {
            healthText = 'Remote service ready (door model loaded).';
          } else if (doorLoaded) {
            healthKind = 'warn';
            healthText = 'Remote service ready (door import is still beta, but you can enable it).';
          } else {
            healthKind = 'warn';
            healthText = 'Remote service ready, but the door model is not loaded. You can still enable door import, but prediction may fail.';
          }

          setStatus(els.health, healthKind, healthText);
          els.detectDoors.disabled = false;
        } else {
          setStatus(els.health, data && data.configured ? 'warn' : 'err', (selected && selected.error) || (data && data.error) || 'Remote service not configured.');
          els.detectDoors.disabled = true;
          els.detectDoors.value = 'false';
        }
      }

      async function loadSources() {
        const remote = await backendRequest('GET', '/tools/zippybim/sources');
        const initialAttachments = Array.isArray(state.initPayload.attachments) ? state.initPayload.attachments : [];
        state.sessionSources = dedupeSources(initialAttachments);
        state.workspaceSources = dedupeSources(remote && Array.isArray(remote.items) ? remote.items : []);
        renderSources();
      }

      async function loadJobs() {
        const remote = await backendRequest('GET', '/tools/zippybim/jobs');
        state.jobs = remote && Array.isArray(remote.items) ? remote.items : [];
        renderJobs();
      }

      async function selectJob(jobId) {
        if (!jobId) return;
        state.selectedJobId = jobId;
        renderJobs();
        const job = await backendRequest('GET', '/tools/zippybim/jobs/' + encodeURIComponent(jobId));
        if (!job || !job.id) {
          setStatus(els.jobStatus, 'err', 'Job not found.');
          return;
        }

        const idx = state.jobs.findIndex(item => item.id === job.id);
        if (idx >= 0) state.jobs[idx] = job;
        else state.jobs.unshift(job);
        renderJobs();

        setStatus(els.jobStatus, job.status === 'failed' ? 'err' : job.status === 'succeeded' ? 'ok' : 'warn',
          (job.status || 'queued') + (job.error ? ': ' + job.error : ''));

        if (job.status === 'succeeded') {
          const result = await backendRequest('GET', '/tools/zippybim/jobs/' + encodeURIComponent(jobId) + '/result');
          state.selectedResult = result && result.ok === false ? null : result;
          renderResult();
        } else {
          state.selectedResult = null;
          renderResult();
          startPolling(jobId);
        }
      }

      function stopPolling() {
        if (state.pollTimer) {
          clearTimeout(state.pollTimer);
          state.pollTimer = null;
        }
      }

      function startPolling(jobId) {
        stopPolling();
        state.pollTimer = setTimeout(async () => {
          await selectJob(jobId);
          const active = state.jobs.find(item => item.id === jobId);
          const status = active ? active.status : null;
          if (status === 'queued' || status === 'running') startPolling(jobId);
        }, 3000);
      }

      async function startJob() {
        const relative_path = normalizePath(els.sourceSelect.value);
        if (!relative_path) {
          setStatus(els.jobStatus, 'err', 'Select a PDF first.');
          return;
        }

        setStatus(els.jobStatus, 'warn', 'Submitting prediction job…');
        const payload = {
          relative_path,
          extractor: currentExtractor(),
          scale_ratio: Number(els.scaleRatio.value || '${escapeForJs(String(defaultScale))}'),
          crop_min_x: Number(els.cropMinX.value || '0'),
          crop_min_y: Number(els.cropMinY.value || '0'),
          crop_max_y: Number(els.cropMaxY.value || '100'),
          detect_doors: els.detectDoors.value === 'true'
        };

        const created = await backendRequest('POST', '/tools/zippybim/jobs', payload);
        state.selectedResult = null;
        renderResult();
        await loadJobs();
        await selectJob(created.id);
      }

      async function placeUnderlayCore(result, showSuccessStatus) {
        const target = result || state.selectedResult;
        if (!canCreateVectorUnderlay(target)) {
          setStatus(els.jobStatus, 'err', 'No extracted vector underlay is available for this result.');
          return;
        }
        const geometry = stripGeometryForApply(target);
        const response = await importVectorUnderlayInBatches(target.source_relative_path, geometry, {
          sourcePath: target.source_relative_path,
          defaultWallHeightFeet: 10,
          minWallLengthFeet: 0.5
        }, 'Placing vector underlay');
        if (showSuccessStatus) {
          setStatus(els.jobStatus, 'ok', 'Placed vector underlay in Revit' + (response.batches > 1 ? ' across ' + response.batches + ' batches.' : '.'));
        }
        els.resultDump.textContent = pretty({
          underlay: response.summary,
          batches: response.batches
        });
      }

      async function applyWalls() {
        const result = state.selectedResult;
        if (!result) return;
        const geometry = stripGeometryForApply(result);
        if (!geometry) return;
        const wallDoorGeometry = filterGeometryElements(geometry, new Set(['wall', 'door']));
        const response = await revitAction('/revit/import-zippybim-geometry', {
          geometry: wallDoorGeometry,
          sourcePath: result.source_relative_path,
          importWalls: true,
          importVectorUnderlay: false,
          importDoors: els.detectDoors.value === 'true',
          disableWallJoins: false,
          defaultWallHeightFeet: 10,
          minWallLengthFeet: 0.5
        });
        const responses = [response];
        let statusKind = 'ok';
        let statusText = 'Applied geometry to Revit.';
        let underlayResult = null;
        if (els.placeUnderlayWithWalls.value === 'true' && canCreateVectorUnderlay(result)) {
          underlayResult = await importVectorUnderlayInBatches(result.source_relative_path, geometry, {
            defaultWallHeightFeet: 10,
            minWallLengthFeet: 0.5
          }, 'Applying vector underlay');
          responses.push(...underlayResult.responses);
          const count = underlayResult.summary.vectorUnderlayCreated || 0;
          statusText = count > 0
            ? 'Applied geometry and placed vector underlay in Revit' + (underlayResult.batches > 1 ? ' across ' + underlayResult.batches + ' batches.' : '.')
            : 'Applied geometry, but no vector underlay segments were available to place.';
          if (count <= 0) statusKind = 'warn';
        } else if (els.placeUnderlayWithWalls.value === 'true') {
          statusKind = 'warn';
          statusText = 'Applied geometry, but no vector underlay segments were available to place.';
        }
        const merged = mergeImportSummaries(responses);
        setStatus(els.jobStatus, statusKind, statusText);
        els.resultDump.textContent = pretty({
          summary: merged,
          wallImport: summarizeImportResult(response),
          underlay: underlayResult ? { batches: underlayResult.batches, summary: underlayResult.summary } : null
        });
      }

      async function placeUnderlay() {
        await placeUnderlayCore(state.selectedResult, true);
      }

      async function bootstrap(initPayload) {
        state.initPayload = initPayload || {};
        state.preferredSourcePath = normalizePath(state.initPayload.preferred_relative_path || '');
        state.selectedSourcePath = state.preferredSourcePath || state.selectedSourcePath;
        const hostBuild = state.initPayload && state.initPayload.hostBuild ? String(state.initPayload.hostBuild) : '';
        if (hostBuild) {
          els.sourceNote.textContent = 'Host build: ' + hostBuild + '. Loading PDF sources…';
        }
        populateScalePresets();
        syncScalePresetFromRatio();
        await loadHealth();
        await Promise.all([loadSources(), loadJobs()]);
      }

      function extractInitPayload(msg) {
        if (!msg || msg.type !== 'host.ready') return null;
        return (msg.payload && msg.payload.initialPayload) || {};
      }

      function bootstrapOnce(initPayload) {
        if (bootstrapPromise) return bootstrapPromise;
        bootstrapPromise = bootstrap(initPayload).catch(err => {
          bootstrapPromise = null;
          setStatus(els.health, 'err', errorText(err, 'Failed to initialize tool host.'));
        });
        return bootstrapPromise;
      }

      async function requestInitPayload() {
        const bridge = host();
        if (!bridge || typeof bridge.getInitPayload !== 'function') return null;
        const payload = await bridge.getInitPayload();
        return payload && payload.initialPayload ? payload.initialPayload : {};
      }

      async function initializeTool() {
        const bridge = host();
        if (!bridge || typeof bridge.onMessage !== 'function') {
          setStatus(els.health, 'err', 'OperatorToolHost bridge not detected.');
          return;
        }

        bridge.onMessage(msg => {
          const initPayload = extractInitPayload(msg);
          if (initPayload == null) return;
          void bootstrapOnce(initPayload);
        });

        const cached = typeof bridge.getLastMessage === 'function'
          ? bridge.getLastMessage()
          : bridge.lastMessage;
        const cachedInitPayload = extractInitPayload(cached);
        if (cachedInitPayload != null) {
          await bootstrapOnce(cachedInitPayload);
          return;
        }

        const requestedInitPayload = await requestInitPayload();
        if (requestedInitPayload != null) {
          await bootstrapOnce(requestedInitPayload);
        }
      }

      window.addEventListener('error', ev => {
        setStatus(els.health, 'err', errorText(ev && ev.error, 'Tool UI script error.'));
      });
      window.addEventListener('unhandledrejection', ev => {
        setStatus(els.health, 'err', errorText(ev && ev.reason, 'Tool UI request failed.'));
      });

      els.btnRefreshSources.addEventListener('click', () => {
        void Promise.all([loadHealth(), loadSources(), loadJobs()]).catch(err => {
          setStatus(els.health, 'err', errorText(err, 'Refresh failed.'));
        });
      });
      els.btnToggleSourceScope.addEventListener('click', () => {
        state.showWorkspaceSources = !state.showWorkspaceSources;
        renderSources();
      });
      els.sourceSelect.addEventListener('change', () => {
        state.selectedSourcePath = normalizePath(els.sourceSelect.value);
        void loadSourcePreview();
      });
      els.drawingScale.addEventListener('change', () => {
        if (els.drawingScale.value === 'custom') return;
        els.scaleRatio.value = String(els.drawingScale.value);
      });
      els.extractorSelect.addEventListener('change', () => {
        void loadHealth().catch(err => {
          setStatus(els.health, 'err', errorText(err, 'Failed to refresh extractor health.'));
        });
      });
      els.scaleRatio.addEventListener('input', () => {
        syncScalePresetFromRatio();
      });
      els.btnStart.addEventListener('click', () => {
        void startJob().catch(err => {
          setStatus(els.jobStatus, 'err', errorText(err, 'Failed to start prediction.'));
        });
      });
      els.btnApplyWalls.addEventListener('click', () => {
        void applyWalls().catch(err => {
          setStatus(els.jobStatus, 'err', errorText(err, 'Failed to apply walls.'));
        });
      });
      els.btnPlaceUnderlay.addEventListener('click', () => {
        void placeUnderlay().catch(err => {
          setStatus(els.jobStatus, 'err', errorText(err, 'Failed to place underlay.'));
        });
      });
      els.btnClose.addEventListener('click', () => { stopPolling(); void host().close(); });

      void initializeTool().catch(err => {
        setStatus(els.health, 'err', errorText(err, 'Failed to initialize tool host.'));
      });
    </script>
  </body>
</html>`;
}
