export function completionOutboxKeyV2(workspace: string): string;
export function retainCompletionOutboxV2(workspace: string, key: string, lease: unknown, envelope: unknown): void;
export function readCompletionOutboxV2(workspace: string, key: string, lease: unknown): unknown | null;
export function retainNativeCompletionDispatchV1(workspace: string, key: string, lease: unknown, native: import("./native-completion.js").NativeCompletionDispatchV1["native"]): void;
export function readNativeCompletionDispatchV1(workspace: string, key: string, lease: unknown): import("./native-completion.js").NativeCompletionDispatchV1 | null;
export function retainLateNativeCompletionV1(workspace: string, key: string, lease: unknown, value: { record_json: string; record_sha256: string }): void;
export function readLateNativeCompletionV1(workspace: string, key: string, lease: unknown): { record_json: string; record_sha256: string } | null;
