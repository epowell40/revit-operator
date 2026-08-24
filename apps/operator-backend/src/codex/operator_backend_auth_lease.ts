import type { OperatorBackendAuthV1 } from "../operator_backend_auth.js";

export type OperatorBackendAuthLease = {
  session_id: string;
  turn_id: string | null;
  auth: OperatorBackendAuthV1;
};

export class OperatorBackendAuthLeaseRegistry {
  private readonly unbound = new Set<OperatorBackendAuthLease>();
  private readonly byTurn = new Map<string, OperatorBackendAuthLease>();

  begin(sessionIdValue: string, auth: OperatorBackendAuthV1): OperatorBackendAuthLease {
    const sessionId = sessionIdValue.trim();
    if (!sessionId || sessionId.length > 300) throw new Error("Operator backend auth lease requires a bounded session id.");
    const lease: OperatorBackendAuthLease = { session_id: sessionId, turn_id: null, auth };
    this.unbound.add(lease);
    return lease;
  }

  bindTurn(lease: OperatorBackendAuthLease, turnIdValue: string): void {
    const turnId = turnIdValue.trim();
    if (!turnId || turnId.length > 300) throw new Error("Operator backend auth lease requires a bounded turn id.");
    if (!this.unbound.has(lease)) throw new Error("Operator backend auth lease is not active.");
    const existing = this.byTurn.get(turnId);
    if (existing && existing !== lease) throw new Error("Operator backend auth lease already exists for this turn.");
    this.unbound.delete(lease);
    lease.turn_id = turnId;
    this.byTurn.set(turnId, lease);
  }

  resolve(turnIdValue: unknown, sessionIdValue: unknown): OperatorBackendAuthV1 {
    const turnId = typeof turnIdValue === "string" ? turnIdValue.trim() : "";
    const sessionId = typeof sessionIdValue === "string" ? sessionIdValue.trim() : "";
    const bound = turnId ? this.byTurn.get(turnId) : undefined;
    if (bound) {
      if (!sessionId || bound.session_id !== sessionId) throw new Error("Operator backend auth lease session binding does not match the current MCP call.");
      return bound.auth;
    }
    const candidates = [...this.unbound].filter(lease => lease.session_id === sessionId);
    if (candidates.length === 1) return candidates[0]!.auth;
    throw new Error("Operator backend authentication is not bound to the current MCP turn.");
  }

  end(lease: OperatorBackendAuthLease | null): void {
    if (!lease) return;
    this.unbound.delete(lease);
    if (lease.turn_id && this.byTurn.get(lease.turn_id) === lease) this.byTurn.delete(lease.turn_id);
    lease.turn_id = null;
  }

  clear(): void {
    this.unbound.clear();
    this.byTurn.clear();
  }
}
