import { SUPPORTED_TOOL_INVENTORY_HASH } from '../capabilities/supported_tool_inventory.js';

/** Authenticate the compiled peer's capability version before admitting any
 * tool use. The probe is local to MCP and does not contact Revit. A matching
 * source tree does not establish that the launched dist files are current. */
export function assertMcpInventoryHandshake(result: unknown): void {
  const probe = result as { isError?: boolean; content?: { type?: string; text?: string }[] };
  const text = probe?.content?.filter(block => block.type === 'text');
  let payload: any;
  try { payload = text?.length === 1 ? JSON.parse(text[0].text ?? '') : null; } catch { payload = null; }
  if (probe?.isError || payload?.status !== 'ok' || payload?.protocol !== 'operator.mcp.runtime.v1'
    || payload?.supportedToolInventory?.hash !== SUPPORTED_TOOL_INVENTORY_HASH) {
    throw new Error('operator_mcp_inventory_mismatch: rebuild and restart the backend and MCP components together. No Revit action was dispatched by the startup probe.');
  }
}
