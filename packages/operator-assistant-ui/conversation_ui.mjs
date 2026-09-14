export function compactWorkSummary(goal, running) {
  if (!running) return "";
  const phase = `${goal?.current_step || ""} ${goal?.current_phase || ""}`.toLowerCase();
  if (/verif|postcondition|confirm/.test(phase)) return "Checking the result…";
  if (/apply|execut|mutat|chang/.test(phase)) return "Making the requested changes…";
  if (/preview/.test(phase)) return "Preparing a preview…";
  if (/research|search/.test(phase)) return "Looking up the details…";
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
