export const REVIT_MODEL_OPEN_PATH_RULE = "- Revit model-open path rule: when context.revit.host is present, it is attested to the exact active Revit process. For a named Autodesk sample, select an exact matching path only from context.revit.host.sample_models and require its version_year to equal context.revit.host.version_year. Never guess another installed Revit year's sample path. If no exact candidate exists, ask one focused path clarification without dispatching revit_open_model. Explicit non-sample absolute paths remain eligible, but an Autodesk Revit Samples path for a different year must be rejected before dispatch.";

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

export function projectContextForSpeedDiet(context: unknown): unknown {
  const ctx = recordValue(context);
  const revit = recordValue(ctx.revit);
  const document = recordValue(revit.document);
  const activeView = recordValue(revit.active_view);
  const capabilities = recordValue(ctx.capabilities);
  const tools = Array.isArray(capabilities.tools) ? capabilities.tools : [];
  return {
    ui: ctx.ui ?? null,
    revit: {
      host: revit.host ?? null,
      document: {
        title: document.title ?? document.name ?? null,
        path: document.path ?? document.file_path ?? null,
        is_workshared: document.is_workshared ?? null
      },
      active_view: {
        id: activeView.id ?? activeView.element_id ?? null,
        name: activeView.name ?? null,
        type: activeView.type ?? activeView.view_type ?? null,
        scale: activeView.scale ?? null
      }
    },
    capabilities: ctx.capabilities
      ? {
          contract_version: capabilities.contract_version ?? capabilities.version ?? null,
          tool_count: tools.length,
          allowlist: capabilities.allowlist ?? null
        }
      : null
  };
}

export function activeHostVersionYear(contextValue: unknown): string {
  const host = recordValue(recordValue(recordValue(contextValue).revit).host);
  const year = typeof host.version_year === "string" ? host.version_year.trim().slice(0, 4) : "";
  return host.schema === "revit-operator.active-host-model-inventory.v1"
    && host.source === "attested_revit_install"
    && host.require_active_version_match === true
    && /^20[2-3]\d$/.test(year)
    ? year
    : "";
}

export function openModelActiveHostMismatch(activeYear: string, targetTokens: string[]): boolean {
  if (!activeYear) return false;
  return targetTokens.filter(token => token.startsWith("path:")).some(token => {
    const sampleYear = token.match(/\/autodesk\/revit (20[2-3]\d)\/samples\//i)?.[1] || "";
    return !!sampleYear && sampleYear !== activeYear;
  });
}

export function evidenceIsKnownNoEffectFailure(
  evidence: unknown,
  options: { firstDocumentOpen: boolean; contextIsLive: boolean }
): boolean {
  const root = recordValue(evidence);
  if (root.request_dispatched === false && root.outcome_unknown !== true) return true;
  const texts: string[] = [];
  let structuredNoDispatch = false;
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || texts.length >= 128 || value === null || value === undefined) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (row.request_dispatched === false && row.outcome_unknown !== true) structuredNoDispatch = true;
      for (const item of Object.values(row)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "string") return;
    texts.push(value);
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) {
      try { visit(JSON.parse(trimmed), depth + 1); } catch {}
    }
  };
  visit(evidence);
  const incompatibleFirstDocumentOpen = options.firstDocumentOpen
    && !options.contextIsLive
    && texts.some(value => /\bmodel was saved (?:by|in) a later version of Revit\b/i.test(value));
  return structuredNoDispatch
    || incompatibleFirstDocumentOpen
    || texts.some(value => /\bbulk_confirm_required\b|\brequires typed confirmation\b/i.test(value));
}
