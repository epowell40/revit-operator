export function completionOutboxKeyV2(workspace: string): string;
export function retainCompletionOutboxV2(workspace: string, key: string, lease: unknown, envelope: unknown): void;
export function readCompletionOutboxV2(workspace: string, key: string, lease: unknown): unknown | null;
