/** Whole host-category shared family content, not effective instance graphics. */
export type FamilyStaticTextScopeV1 = Readonly<{
  kind: 'family_static_text_v1'; category: string; expected_text: string;
}>;
export function validFamilyStaticTextScopeV1(value: unknown): value is FamilyStaticTextScopeV1 {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const v=value as FamilyStaticTextScopeV1;
  return Object.keys(v).every(k=>['kind','category','expected_text'].includes(k))
    &&v.kind==='family_static_text_v1'&&typeof v.category==='string'&&v.category.trim()===v.category
    &&v.category.length>0&&v.category.length<=256&&!/[\u0000-\u001f\u007f]/.test(v.category)
    &&(!/^OST_/i.test(v.category)||/^OST_[A-Za-z0-9_]+$/.test(v.category))
    &&typeof v.expected_text==='string'&&v.expected_text.trim()===v.expected_text
    &&v.expected_text.length>0&&v.expected_text.length<=2048&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.expected_text);
}
