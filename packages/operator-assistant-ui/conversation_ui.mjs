// Display only: these observations never establish task progress/completion.
function activityLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 220) : '';
}

function friendlyActivity(value, fallback = '') {
  const text = activityLine(value);
  if (/waiting for (?:the next |initial )?model response|requesting initial model response/i.test(text)) return 'Waiting for the agent’s response…';
  if (/checking result before completing|postcondition|verifying|checking the result/i.test(text)) return 'Checking the result…';
  if (/captur.*screenshot|model requested a screenshot/i.test(text)) return 'Inspecting the current view…';
  if (/read active Revit context|checking the active Revit project/i.test(text)) return 'Checking the current model…';
  if (/native__(?:get|read|query|inspect|find|list|collect)[_\w]*/i.test(text)) return 'Reading model information…';
  if (/native__(?:save|saveas)/i.test(text)) return 'Saving the model…';
  if (/native__(?:move|set|create|delete|update|place|connect)[_\w]*/i.test(text)) return 'Applying a model operation…';
  if (/Step \d+: running|^native__|^revit_|^execute_|^delegate_revit_task$|native-only Revit owner/i.test(text)) return 'Running a Revit operation…';
  if (/evaluating tool calls for step/i.test(text)) return 'Preparing the next action…';
  if (/continuing (?:the same|with tool|the saved)|assignment has ready work/i.test(text)) return 'Continuing the remaining work…';
  if (/pause requested|stop requested|waiting for admitted work/i.test(text)) return 'Pausing after the current operation settles…';
  if (/recovering backend|settling|rate.limit|retrying.*model/i.test(text)) return 'Waiting for the connection or service…';
  if (/^Starting (?:computer-use run|task)/i.test(text)) return 'Starting the task…';
  return fallback;
}

function activityTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value); return Number.isFinite(time) ? time : null;
}

function activityDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function taskActivityPresentation(input = {}) {
  if (input.running !== true) return { visible: false, tone: 'idle', label: '', detail: '', elapsed: '', recent: [] };
  const now = activityTime(input.now) ?? Date.now(), progress = input.progress || {};
  const started = activityTime(progress.startedAt) ?? activityTime(input.startedAt);
  const updated = activityTime(progress.updatedAt) ?? activityTime(input.updatedAt) ?? started;
  const lastSeen = activityTime(input.lastSeenAt);
  const disconnected = input.connectionLost === true || lastSeen !== null && now - lastSeen > 20000;
  const quiet = updated !== null && now - updated > 45000;
  const agent = activityLine(input.agentProgress);
  const current = friendlyActivity(progress.currentAction, activityLine(progress.currentAction));
  const latest = friendlyActivity(progress.lastEvent);
  const label = disconnected ? 'Connection interrupted. Checking task status…' : agent || current || latest || activityLine(input.fallback) || 'Working on your task…';
  const recent = [];
  for (const event of (Array.isArray(input.events) ? input.events.slice(-40) : [])) {
    const line = friendlyActivity(event?.text);
    if (!line) continue;
    const previous = recent.indexOf(line); if (previous >= 0) recent.splice(previous, 1);
    recent.push(line);
  }
  return { visible: true, tone: disconnected || quiet ? 'waiting' : 'working', label,
    detail: disconnected ? 'The last known task state is retained. No work has been resubmitted.'
      : quiet ? `No new activity for ${activityDuration(now - updated)}. Waiting for an update; completion is not yet confirmed.` : '',
    elapsed: started !== null ? `${activityDuration(now - started)} elapsed` : '', recent: recent.slice(-4) };
}

export function renderTaskActivity(container, input) {
  if (!container) return;
  const view = taskActivityPresentation(input);
  container.hidden = !view.visible;
  container.dataset.tone = view.tone;
  if (!view.visible) { container._activityNodes = null; container.replaceChildren(); return; }
  let nodes = container._activityNodes;
  if (!nodes) {
    const doc = container.ownerDocument;
    const make = (tag, cls) => { const el = doc.createElement(tag); el.className = cls; return el; };
    const heading = make('div', 'taskActivityHeading'), indicator = make('span', 'taskActivityIndicator');
    indicator.setAttribute('aria-hidden', 'true');
    const label = make('span', 'taskActivityLabel'), timer = make('span', 'taskActivityTimer');
    label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
    timer.setAttribute('role', 'timer'); timer.setAttribute('aria-live', 'off');
    heading.append(indicator, label, timer);
    const detail = make('p', 'taskActivityDetail'), details = make('details', 'taskActivityHistory');
    const summary = make('summary', ''); summary.textContent = 'Recent updates';
    const list = make('ol', ''); details.append(summary, list); container.replaceChildren(heading, detail, details);
    nodes = container._activityNodes = { label, timer, detail, details, list, signature: '' };
  }
  if (nodes.label.textContent !== view.label) nodes.label.textContent = view.label;
  nodes.timer.textContent = view.elapsed;
  nodes.detail.textContent = view.detail; nodes.detail.hidden = !view.detail;
  nodes.details.hidden = !view.recent.length;
  const signature = JSON.stringify(view.recent);
  if (signature !== nodes.signature) {
    nodes.signature = signature;
    nodes.list.replaceChildren(...view.recent.map(text => { const li = container.ownerDocument.createElement('li'); li.textContent = text; return li; }));
  }
}

export function compactWorkSummary(goal, running) {
  if (!running) return "";
  const phase = `${goal?.current_step || ""} ${goal?.current_phase || ""}`.toLowerCase();
  const effect = goal?._projection?.execution?.requested_effect || goal?.work_budget?.requested_effect || goal?.requested_effect;
  if (/verif|postcondition|confirm/.test(phase)) return "Checking the result…";
  if (/preview/.test(phase)) return "Preparing a preview…";
  if (/research|search/.test(phase)) return "Looking up the details…";
  if (/apply|execut|mutat|chang/.test(phase)) {
    if (effect === "read") return "Checking the model…";
    if (effect === "preview") return "Preparing a preview…";
    if (effect === "apply" || /apply|mutat|chang/.test(phase)) return "Making the requested changes…";
  }
  if (/observ|discover|inspect|context|read/.test(phase)) return "Checking the model…";
  return "Working…";
}

export function mergeConversationHistory(current, history) {
  const live = Array.isArray(current) ? current : [];
  const liveById = new Map(live.filter(message => message.id).map(message => [`${message.role}:${message.id}`, message]));
  const seen = new Set();
  const merged = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.message_id !== "string" || typeof item.text !== "string") continue;
    const key = `${item.role}:${item.message_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(liveById.get(key) || { id: item.message_id, role: item.role, text: item.text,
      attachments: Array.isArray(item.attachments) ? item.attachments : [] });
  }
  for (const message of live) {
    if (!message.id || !seen.has(`${message.role}:${message.id}`)) merged.push(message);
  }
  return merged;
}

export function conciseStatus(text) {
  if (/^(?:Sidecar ready\.?|Ready\.?)$/i.test(text)) return "Ready";
  if (/^(?:Starting backend session|Connecting to backend)/i.test(text)) return "Connecting…";
  return text;
}

export function appendInlineText(container, text) {
  const document = container.ownerDocument;
  for (const part of String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      container.appendChild(strong);
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      container.appendChild(code);
    } else container.appendChild(document.createTextNode(part));
  }
}

/** Split display text only. Opening a local link remains subject to the host's
 * existing workspace/output-path policy; this function grants no file access. */
export function linkedTextParts(text) {
  const source = String(text || ""), parts = [];
  const pattern = /\[([^\]\n]{1,160})\]\s*\(\s*((?:file:\/\/\/|https?:\/\/|op:\/\/)[^)]+?)\s*\)|`([A-Za-z]:\\[^`\r\n]+?\.(?:pdf|png|jpe?g|docx?|xlsx?|csv|txt|rvt|rfa))`|((?:file:\/\/\/|https?:\/\/|op:\/\/)[^\s<>"')]+)|([A-Za-z]:\\[^\r\n<>"]+?\.(?:pdf|png|jpe?g|docx?|xlsx?|csv|txt|rvt|rfa))/gi;
  let last = 0, match;
  while ((match = pattern.exec(source))) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index) });
    const rawPath = match[3] || match[5] || "";
    let href = String(match[2] || match[4] || rawPath).trim();
    while (/[),.;:]$/.test(href)) href = href.slice(0, -1);
    const label = match[1] || href;
    if (/^[A-Za-z]:\\/.test(href)) href = `file:///${href.replace(/\\/g, "/")}`;
    parts.push({ href, label });
    last = pattern.lastIndex;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });
  return parts;
}

function tableCells(line) {
  if (line.length > 12000 || !line.includes("|")) return null;
  const input = line.trim(), cells = [];
  let value = "", codeTicks = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "\\" && input[i + 1] === "|") { value += "|"; i++; continue; }
    if (char === "`") {
      let count = 1;
      while (input[i + count] === "`") count++;
      if (!codeTicks) codeTicks = count; else if (codeTicks === count) codeTicks = 0;
      value += "`".repeat(count); i += count - 1; continue;
    }
    if (char === "|" && !codeTicks) { cells.push(value.trim()); value = ""; }
    else value += char;
  }
  cells.push(value.trim());
  if (input.startsWith("|") && cells[0] === "") cells.shift();
  if (input.endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells.length > 0 && cells.length <= 24 ? cells : null;
}

/** A small DOM renderer: all content stays text; model HTML is never executed. */
export function renderAssistantBlocks(container, text, renderInline = appendInlineText) {
  container.replaceChildren();
  const document = container.ownerDocument;
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [], list = null, listType = null, target = container;
  const block = (tag, content) => { const node = document.createElement(tag); renderInline(node, content); target.appendChild(node); return node; };
  const flush = () => { if (paragraph.length) block("p", paragraph.join("\n")); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); list = null; const codeLines = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) codeLines.push(lines[i]);
      const pre = document.createElement("pre"), code = document.createElement("code");
      code.textContent = codeLines.join("\n"); pre.appendChild(code); target.appendChild(pre); continue;
    }
    const header = tableCells(line), separators = i + 1 < lines.length ? tableCells(lines[i + 1]) : null;
    if (header && separators && header.length === separators.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flush(); list = null;
      const wrapper = document.createElement("div"), table = document.createElement("table");
      wrapper.className = "assistantTable";
      const head = document.createElement("thead"), body = document.createElement("tbody");
      const appendRow = (parent, values, tag) => {
        const row = document.createElement("tr");
        values.forEach((value, index) => {
          const cell = document.createElement(tag);
          cell.className = separators[index].endsWith(":") ? (separators[index].startsWith(":") ? "alignCenter" : "alignRight") : "alignLeft";
          renderInline(cell, value); row.appendChild(cell);
        });
        parent.appendChild(row);
      };
      appendRow(head, header, "th"); i++;
      for (let rowCount = 0; rowCount < 200 && i + 1 < lines.length; rowCount++) {
        const values = tableCells(lines[i + 1]);
        if (!values || values.length !== header.length) break;
        appendRow(body, values, "td"); i++;
      }
      table.appendChild(head); table.appendChild(body); wrapper.appendChild(table); target.appendChild(wrapper); continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      flush(); list = null;
      if (heading[1].length <= 2) target = container;
      if (heading[1] === "##" && ["Model evidence", "Details"].includes(heading[2].trim())) {
        const details = document.createElement("details"), summary = document.createElement("summary");
        details.className = "modelEvidence"; summary.textContent = heading[2].trim();
        details.appendChild(summary); container.appendChild(details); target = details;
      } else block(`h${Math.min(heading[1].length + 1, 6)}`, heading[2]);
      continue;
    }
    const item = line.match(/^\s*(?:([-*+])\s+|(\d+)[.)]\s+)(.+)$/);
    if (item) {
      flush(); const tag = item[2] ? "ol" : "ul";
      if (!list || listType !== tag) { list = document.createElement(tag); listType = tag; if (tag === "ol") list.start = Number(item[2]); target.appendChild(list); }
      const li = document.createElement("li"); renderInline(li, item[3]); list.appendChild(li); continue;
    }
    if (!line.trim()) { flush(); list = null; continue; }
    if (/^>\s?/.test(line)) { flush(); list = null; block("blockquote", line.replace(/^>\s?/, "")); continue; }
    list = null; paragraph.push(line);
  }
  flush();
}
