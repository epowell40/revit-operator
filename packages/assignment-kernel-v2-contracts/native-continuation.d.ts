/** Protocol decoding only; never an admission or trust decision. */
export function nativeSourceInventoryRequestV1(value:unknown):{kind:'regular'|'panel'|'all'|'power_circuits';max:number}|undefined;
export function nativeSourceInventoryWorkloadV1(value:unknown,raw:unknown):{inventory_kind:'regular'|'panel'|'all'|'power_circuits';item_count:number}|undefined;
export function nativeTemplateParameterChangeV1(value: unknown): { elementId:number; value:string; expectedOldValue:string } | undefined;
export type NativeTemplateRequestV1 =
  | { view_id:number; kind:'typed_parameter'|'native_parameter'; expected_old_id:number; requested_id:number }
  | { view_id:number; kind:'native_visibility'; requested_name:string };
export function nativeTemplateRequestV1(value: unknown): NativeTemplateRequestV1 | undefined;
export function nativeTemplateResultStateV1(value: unknown, raw: unknown): { view_id:number; template_id:number } | undefined;
export function nativeFamilySessionRequestV1(value: unknown): {kind:'open'} | {kind:'close_without_save'; session_id:string} | undefined;
