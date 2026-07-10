import test from "node:test";
import assert from "node:assert/strict";
import {
  handleSemanticMepRoutePlan,
  registerSemanticMepRouteTool,
  semanticMepRouteInputSchema,
  type SemanticMepRouteToolInput
} from "./semanticMepRouteTool.js";

test("semantic MEP MCP tool rejects apply/write controls and forwards only planning inputs", async () => {
  assert.equal(semanticMepRouteInputSchema.safeParse({ userText: "Route pipe to sink", apply: true }).success, false);
  assert.equal(semanticMepRouteInputSchema.safeParse({ userText: "Route pipe to sink", write: true }).success, false);

  let received: unknown;
  const response = await handleSemanticMepRoutePlan(
    { userText: "Route pipe to sink", viewId: 101, roomNumber: "405" },
    {
      async planSemanticMepRoute(input) {
        received = input;
        return { ok: true, status: "needs_discovery" };
      }
    }
  );

  assert.deepEqual(received, { userText: "Route pipe to sink", viewId: 101, roomNumber: "405" });
  assert.deepEqual(JSON.parse(response.content[0]?.text ?? "{}"), { ok: true, status: "needs_discovery" });
});

test("semantic MEP MCP tool registers one explicit read-only surface", async () => {
  let registered: { name?: string; description?: string; schema?: unknown; handler?: (input: SemanticMepRouteToolInput) => Promise<unknown> } = {};
  registerSemanticMepRouteTool((name, description, schema, handler) => {
    registered = { name, description, schema, handler };
  }, {
    async planSemanticMepRoute() {
      return { ok: true };
    }
  });

  assert.equal(registered.name, "operator_plan_semantic_mep_route");
  assert.match(registered.description ?? "", /never applies or writes/i);
  assert.equal(registered.schema, semanticMepRouteInputSchema);
  const result = await registered.handler?.({ userText: "Route pipe to sink" });
  assert.deepEqual(JSON.parse((result as any).content[0].text), { ok: true });
});
