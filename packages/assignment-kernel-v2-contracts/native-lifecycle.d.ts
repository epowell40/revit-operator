export interface NativeLifecycleReceiptV1 {
 schema: 'revit-operator.native-lifecycle.v1'; path: string; action: string; document_session_id: string;
 native_call_attempted: true; native_call_returned: true; transaction_ownership: 'revit_api'; status: 'returned';
}
export function nativeLifecycleReceiptEffectV1(value: unknown, method: unknown, path: unknown, effect: unknown): 'applied' | null;
export function nativeLifecycleResultEffectV2(value: unknown): 'applied' | null;
export function nativeLifecycleActionMatchesV1(receipt: unknown, path: unknown, body: unknown): boolean;
