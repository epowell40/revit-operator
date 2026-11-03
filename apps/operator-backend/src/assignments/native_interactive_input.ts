import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import type { OperationV2 } from '../domain/assignment-kernel/operation.js';
import { canonicalJsonV2 } from '../domain/assignment-kernel/canonical.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/** Pending transport ownership, not a second task controller or native-effect
 * authority. Admission must consult this live registry, never a client claim.
 * No serialized/client-authored lease can recreate a live pending invocation.
 */
export class NativeInteractiveInputOwnership {
  private readonly live = new Map<string, {
    operationId: string; signature: string; binding: string; control: string | null;
    deadline: string; admittedVersion: number;
  }>();

  constructor(private readonly now: () => number = Date.now) {}

  register(snapshot: AssignmentSnapshotV2, operationId: string, expectedRequestSignature: string,
    pendingInvocation: Promise<unknown>): void {
    const key = canonicalJsonV2(snapshot.current_binding);
    const op = snapshot.operations[operationId];
    if (this.live.has(key) || !(pendingInvocation instanceof Promise)
      || !this.eligible(snapshot, op) || op.request_identity?.request_signature !== expectedRequestSignature)
      throw new Error('native_interactive_input_ownership_refused');
    const entry = { operationId, signature: expectedRequestSignature, binding: key,
      control: snapshot.execution_control?.command_id ?? null, deadline: op.deadline_at,
      admittedVersion: op.admitted_assignment_version! };
    this.live.set(key, entry);
    const remove = () => { if (this.live.get(key) === entry) this.live.delete(key); };
    // Rejection is retained by the existing native operation; removal is not
    // settlement, retry permission, cancellation, or proof of no model effect.
    void pendingInvocation.then(remove, remove);
  }

  operationAwaitingInput(snapshot: AssignmentSnapshotV2): OperationV2 | null {
    const key = canonicalJsonV2(snapshot.current_binding), entry = this.live.get(key);
    if (!entry) return null;
    const op = snapshot.operations[entry.operationId];
    if (!this.eligible(snapshot, op) || entry.binding !== canonicalJsonV2(op.binding)
      || entry.control !== (snapshot.execution_control?.command_id ?? null)
      || entry.deadline !== op.deadline_at || entry.admittedVersion !== op.admitted_assignment_version
      || entry.signature !== op.request_identity?.request_signature) return null;
    return op;
  }

  private eligible(snapshot: AssignmentSnapshotV2, op: OperationV2 | undefined): op is OperationV2 {
    const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
    const now = this.now(), deadline = Date.parse(op?.deadline_at ?? '');
    return Boolean(op && Number.isFinite(now) && Number.isFinite(deadline) && deadline > now
      && snapshot.outcome === 'active' && !snapshot.terminal && snapshot.quiescent === false
      && (snapshot.execution_control === undefined || snapshot.execution_control.state === 'running')
      && !snapshot.provider_budget_exhausted && !snapshot.provider_usage_hold && !snapshot.completion_proposal
      && empty(snapshot.in_flight_provider_call_ids) && empty(snapshot.unresolved_unknown_operation_ids)
      && empty(snapshot.pending_review_ids) && empty(snapshot.pending_input_variable_ids)
      && snapshot.in_flight_operation_ids.length === 1 && snapshot.in_flight_operation_ids[0] === op.operation_id
      && canonicalJsonV2(op.binding) === canonicalJsonV2(snapshot.current_binding)
      && typeof op.binding.document_fingerprint === 'string' && op.binding.document_fingerprint.length > 0
      && op.target.document_fingerprint === op.binding.document_fingerprint
      && Number.isSafeInteger(op.admitted_assignment_version) && op.admitted_assignment_version! > 0
      && op.admitted_assignment_version! <= snapshot.assignment_version
      && op.admission_state === 'admitted' && op.requested_effect === 'apply' && op.purpose === 'work'
      && op.operation_role === 'root' && !op.parent_operation_id
      && op.request_identity?.capability_id === 'revit_call_tool' && op.capability_id === 'revit_call_tool'
      && op.request_identity.method === 'POST'
      && op.request_identity.path === '/revit/place-mep-accessory-interactively'
      && op.input.method === 'POST' && op.input.path === op.request_identity.path
      && typeof op.request_identity.request_signature === 'string' && op.request_identity.request_signature.length > 0
      && ['dispatching', 'dispatched'].includes(op.dispatch_state) && Boolean(op.dispatch_started_at)
      && op.settlement_state === 'awaiting_result' && !op.result && !op.settled_at
      && !op.observation_commit && !op.native_completion_reconciliation);
  }
}

export const nativeInteractiveInputOwnership = new NativeInteractiveInputOwnership();

/** Await the existing invocation's readback before reasoning. This neither
 * consumes/retries the native result nor admits a provider; run must perform
 * the existing fresh binding/control/budget admission synchronously. */
export async function afterNativeInteractiveReadback<T>(pending:Promise<unknown>|null,run:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(signal?.aborted)throw Error('native_readback_wait_aborted');
  if(pending)await new Promise<void>((resolve,reject)=>{
    const abort=()=>{signal?.removeEventListener('abort',abort);reject(Error('native_readback_wait_aborted'));};
    signal?.addEventListener('abort',abort,{once:true});
    pending.then(()=>{signal?.removeEventListener('abort',abort);signal?.aborted?abort():resolve();},error=>{
      signal?.removeEventListener('abort',abort);reject(error);
    });
  });
  if(signal?.aborted)throw Error('native_readback_wait_aborted');
  return run();
}

type Invocation = {
  binding: string; signature: string; result: Promise<unknown>;
  ready: (operation: OperationV2) => void; registered: boolean;
};
const invocation = new AsyncLocalStorage<Invocation>();

/** Carry ownership through the existing dynamic-tool invocation. The result is
 * the original invocation, including its canonical settlement. There is no
 * redispatch, fabricated operation result, or independent timeout settlement.
 */
export function withNativeInteractiveInvocation<T>(binding: AssignmentSnapshotV2['current_binding'],
  signature: string, invoke: () => Promise<T>, ownership = nativeInteractiveInputOwnership): {
    result: Promise<T>; ready: Promise<OperationV2>;
  } {
  let ready!: (operation: OperationV2) => void;
  const started = new Promise<OperationV2>(resolve => { ready = resolve; });
  const context = { binding: canonicalJsonV2(binding), signature, ready, registered: false } as Invocation;
  // Defer execution until the exact result Promise is assigned. The dispatch
  // observer is captured in the caller's async context before MCP callbacks.
  const result = Promise.resolve().then(() => invocation.run(context, invoke));
  context.result = result;
  invocationOwners.set(context, ownership);
  void result.then(() => invocationOwners.delete(context), () => invocationOwners.delete(context));
  return { result, ready: started };
}

const invocationOwners = new WeakMap<Invocation, NativeInteractiveInputOwnership>();

/** An interactive request must enter through the existing desktop transport;
 * another native agent/endpoint cannot start an orphaned input wait. Ordinary
 * native calls keep their existing admission unchanged. */
export function requireNativeInteractiveInvocation(snapshot:AssignmentSnapshotV2,tool:string,args:Record<string,unknown>):void {
  if(tool!=='revit_call_tool'||String(args.path??'').trim().toLowerCase()!=='/revit/place-mep-accessory-interactively')return;
  const context=invocation.getStore();
  const signature=createHash('sha256').update(canonicalJsonV2({capability_id:tool,
    method:String(args.method??'').trim().toUpperCase(),path:String(args.path??'').trim(),body:args.body??null}),'utf8').digest('hex');
  if(!context||!invocationOwners.has(context)||context.registered||canonicalJsonV2(snapshot.current_binding)!==context.binding
    ||signature!==context.signature)throw Error('native_interactive_owned_desktop_invocation_required');
}

/** Capture before entering a separately created MCP event emitter. Only the
 * exact admitted request inside this invocation may signal dispatch ownership.
 * The legacy `ready` promise means ownership is registered, NOT that Revit has
 * finished preparation or entered placement mode. Actual UI readiness must be
 * inspected before input. This never proves a committed or verified edit.
 */
export function captureNativeInteractiveDispatchObserver(): (snapshot: AssignmentSnapshotV2, operationId: string) => void {
  const context = invocation.getStore();
  return (snapshot, operationId) => {
    if (!context || context.registered || canonicalJsonV2(snapshot.current_binding) !== context.binding) return;
    const ownership = invocationOwners.get(context);
    if (!ownership) return;
    // A concurrent Pause or another admission fence can deny continuation.
    // That must not turn an already accepted native call into a dispatch error.
    try { ownership.register(snapshot, operationId, context.signature, context.result); }
    catch { return; }
    context.registered = true;
    context.ready(snapshot.operations[operationId]!);
  };
}
