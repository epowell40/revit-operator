import Ajv, { type ValidateFunction } from "ajv";

/** Validate locally before opening an operation or sending anything to MCP.
 * Remote error text cannot establish that a potentially mutating call never ran.
 */
export class McpInputValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, allowUnionTypes: true });
  private readonly validators = new Map<string, ValidateFunction>();

  validate(tool: string, input: unknown, tools: ReadonlyArray<{ name: string; inputSchema: unknown }>): void {
    let validate = this.validators.get(tool);
    if (!validate) {
      const definition = tools.find(candidate => candidate.name === tool);
      if (!definition) throw new Error(`Tool is not advertised by the connected MCP runtime: ${tool.slice(0, 160)}`);
      validate = this.ajv.compile(definition.inputSchema as object);
      this.validators.set(tool, validate);
    }
    if (!validate(input)) {
      const errors = (validate.errors ?? []).slice(0, 8).map(error => ({
        path: error.instancePath, rule: error.keyword, message: error.message, limits: error.params
      }));
      throw new Error(`Invalid arguments for ${tool.slice(0, 160)}; no tool was dispatched. ${JSON.stringify(errors).slice(0, 4_000)}`);
    }
  }

  clear(): void { this.validators.clear(); }
}
