export type NativeResultTargets = { element_ids?: number[]; result_field?: string };
export function normalizeNativeResultTargets(value: unknown, mode: string): NativeResultTargets | undefined;
export function resolveNativeResultTargets(value: unknown, programResult: unknown): number[] | undefined;
