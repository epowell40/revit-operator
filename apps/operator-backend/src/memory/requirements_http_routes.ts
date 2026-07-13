import {
  createRequirement,
  listRequirements,
  resolveRequirements,
  retireRequirement,
  reviseRequirement
} from "./requirements_store.js";

export type RequirementsHttpRouteResult = {
  status: number;
  body: unknown;
  audit?: { type: string; ts: string; requirement_id: string; revision: number };
};

type RequirementsHttpRouteArgs = {
  method: string;
  url: URL;
  actor_id: string | null;
  read_body: () => Promise<unknown>;
};

function errorResult(error: unknown, revisionConflict = false): RequirementsHttpRouteResult {
  const message = error instanceof Error ? error.message : String(error);
  return { status: revisionConflict && /Revision conflict/.test(message) ? 409 : 400, body: { ok: false, error: message } };
}

export async function handleRequirementsHttpRoute(args: RequirementsHttpRouteArgs): Promise<RequirementsHttpRouteResult | null> {
  const { method, url, actor_id, read_body } = args;
  if (method === "GET" && url.pathname === "/memory/requirements") {
    try {
      const scopeKind = url.searchParams.get("scope_kind");
      const scopeId = url.searchParams.get("scope_id");
      const statusRaw = url.searchParams.get("status");
      const status = statusRaw === "retired" || statusRaw === "all" ? statusRaw : "active";
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
      const scope = scopeKind && scopeId ? { kind: scopeKind as any, id: scopeId } : undefined;
      return { status: 200, body: { ok: true, requirements: listRequirements({ scope, status, limit }) } };
    } catch (error) {
      return errorResult(error);
    }
  }

  if (method === "POST" && url.pathname === "/memory/requirements") {
    const body = await read_body().catch(() => null);
    try {
      const parsed = body && typeof body === "object" ? body as any : {};
      const saved = createRequirement({
        scope: parsed.scope,
        key: parsed.key,
        text: parsed.text,
        tags: parsed.tags,
        effective_from: parsed.effective_from,
        effective_until: parsed.effective_until,
        supersedes_requirement_ids: parsed.supersedes_requirement_ids,
        source: parsed.source ?? "api",
        session_id: parsed.session_id,
        actor_id,
        evidence: parsed.evidence
      });
      return {
        status: 201,
        body: saved,
        audit: { type: "requirements.created", ts: new Date().toISOString(), requirement_id: saved.requirement.requirement_id, revision: saved.requirement.revision }
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  if (method === "POST" && url.pathname === "/memory/requirements/revise") {
    const body = await read_body().catch(() => null);
    try {
      const parsed = body && typeof body === "object" ? body as any : {};
      const saved = reviseRequirement({
        requirement_id: parsed.requirement_id,
        expected_revision: Number(parsed.expected_revision),
        scope: parsed.scope,
        key: parsed.key,
        text: parsed.text,
        tags: parsed.tags,
        effective_from: parsed.effective_from,
        effective_until: parsed.effective_until,
        supersedes_requirement_ids: parsed.supersedes_requirement_ids,
        source: parsed.source ?? "api.revise",
        session_id: parsed.session_id,
        actor_id,
        evidence: parsed.evidence
      });
      return {
        status: 200,
        body: saved,
        audit: { type: "requirements.revised", ts: new Date().toISOString(), requirement_id: saved.requirement.requirement_id, revision: saved.requirement.revision }
      };
    } catch (error) {
      return errorResult(error, true);
    }
  }

  if (method === "POST" && url.pathname === "/memory/requirements/retire") {
    const body = await read_body().catch(() => null);
    try {
      const parsed = body && typeof body === "object" ? body as any : {};
      const saved = retireRequirement({
        requirement_id: parsed.requirement_id,
        expected_revision: Number(parsed.expected_revision),
        source: parsed.source ?? "api.retire",
        session_id: parsed.session_id,
        actor_id,
        evidence: parsed.evidence
      });
      return {
        status: 200,
        body: saved,
        audit: { type: "requirements.retired", ts: new Date().toISOString(), requirement_id: saved.requirement.requirement_id, revision: saved.requirement.revision }
      };
    } catch (error) {
      return errorResult(error, true);
    }
  }

  if (method === "POST" && url.pathname === "/memory/requirements/resolve") {
    const body = await read_body().catch(() => null);
    try {
      const parsed = body && typeof body === "object" ? body as any : {};
      const receipt = resolveRequirements({ scope_refs: parsed.scope_refs, query: parsed.query, at: parsed.at, max_results: parsed.max_results });
      return { status: receipt.status === "resolved" ? 200 : 409, body: { ok: receipt.status === "resolved", receipt } };
    } catch (error) {
      return errorResult(error);
    }
  }

  return null;
}
