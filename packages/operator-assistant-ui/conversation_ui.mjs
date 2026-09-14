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

/** A small DOM renderer: all content stays text; model HTML is never executed. */
export function renderAssistantBlocks(container, text, renderInline = appendInlineText) {
  container.replaceChildren();
  const document = container.ownerDocument;
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [], list = null, listType = null;
  const block = (tag, content) => { const node = document.createElement(tag); renderInline(node, content); container.appendChild(node); return node; };
  const flush = () => { if (paragraph.length) block("p", paragraph.join("\n")); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); list = null; const codeLines = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) codeLines.push(lines[i]);
      const pre = document.createElement("pre"), code = document.createElement("code");
      code.textContent = codeLines.join("\n"); pre.appendChild(code); container.appendChild(pre); continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) { flush(); list = null; block(`h${Math.min(heading[1].length + 1, 6)}`, heading[2]); continue; }
    const item = line.match(/^\s*(?:([-*+])\s+|(\d+)[.)]\s+)(.+)$/);
    if (item) {
      flush(); const tag = item[2] ? "ol" : "ul";
      if (!list || listType !== tag) { list = document.createElement(tag); listType = tag; if (tag === "ol") list.start = Number(item[2]); container.appendChild(list); }
      const li = document.createElement("li"); renderInline(li, item[3]); list.appendChild(li); continue;
    }
    if (!line.trim()) { flush(); list = null; continue; }
    if (/^>\s?/.test(line)) { flush(); list = null; block("blockquote", line.replace(/^>\s?/, "")); continue; }
    list = null; paragraph.push(line);
  }
  flush();
}
