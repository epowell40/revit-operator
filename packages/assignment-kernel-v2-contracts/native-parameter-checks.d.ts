export type NativeParameterCheck = { element_id: number; parameter_name: string; expected_value: string };
export function normalizeNativeParameterChecks(value: unknown, mode: string): NativeParameterCheck[] | undefined;
