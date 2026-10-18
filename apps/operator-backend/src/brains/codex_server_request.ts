import type {CodexServerRequest} from "../codex/app_server.js";
import type {CodexMcpToolRuntime} from "../codex/mcp_tool_runtime.js";
import {handleCodexDynamicToolCall} from "./codex_dynamic_tool_handler.js";

export async function handleCodexServerRequest(runtime: CodexMcpToolRuntime, request: CodexServerRequest): Promise<unknown> {
  if (request.method === "item/tool/call") return await handleCodexDynamicToolCall(runtime, request);
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (request.method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (request.method === "item/tool/requestUserInput") return { answers: {} };
  if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
  throw new Error(`Unsupported Codex server request: ${request.method}`);
}

export async function handleCertifiedCodexServerRequest(request: CodexServerRequest): Promise<unknown> {
  const method = request.method.toLowerCase();
  if (/(?:^|\/)(?:dynamic)?tool\/call$/.test(method) || (method.startsWith("mcp") && request.method !== "mcpServer/elicitation/request")) {
    return { contentItems: [{ type: "inputText", text: "Certified direct mode does not permit dynamic, MCP, or Revit tool execution." }], success: false };
  }
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (request.method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (request.method === "item/tool/requestUserInput") return { answers: {} };
  if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
  throw new Error(`Unsupported certified Codex server request: ${request.method}`);
}

