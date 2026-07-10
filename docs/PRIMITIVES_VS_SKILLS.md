# Primitives vs Skills

## Simple model

- **Primitives** are direct Revit tool actions such as move, rotate, select, capture, place family, or duplicate type.
- **Skills** are reusable playbooks that combine primitives into safe user workflows.

## Where primitives live

- Revit endpoint registration: `apps/revit-bridge-addin/RevitBridge.Logic/LogicService.cs`
- Operator-visible catalog: `apps/revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs`
- Tool contracts: `apps/revit-bridge-addin/RevitBridge/Handlers/ToolIntrospectionHandlers.cs`
- MCP wrappers: `apps/mcp-server/src/server.ts`

## Where skills live

- Shared workflow skills: `skills/workflows/`
- Shared runbooks: `skills/runbooks/`
- Shared assets/configuration: `skills/assets/`
- Local/private extensions: `skills/local/`, `%LOCALAPPDATA%\RevitOperator\Skills\`, or `OPERATOR_LOCAL_SKILLS_DIR`

Most low-level capabilities are tool primitives rather than separate markdown skills. Markdown skills provide higher-level routing, safety, and verification procedures.

## Inspect current capability

In Operator chat:

- `show capabilities`
- `describe tool /revit/move-elements`
- `describe tool /revit/rotate-elements`
- `describe tool /revit/set-selection`
- `describe tool /revit/export-image`
- `describe tool /revit/duplicate-element-type`
