import assert from "node:assert/strict";
import test from "node:test";
import { __testOnlyBuildPromptForRequest } from "../src/brains/openai_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";

test("model-open prompt preserves the attested active-year sample inventory under the speed diet", async () => {
  const request: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "model-open-active-year",
    message_id: "message-1",
    user_text: "Open the Snowdon Towers Sample HVAC model.",
    context: {
      ui: {
        speed_settings: {
          context_diet: true,
          include_full_revit_state: false
        }
      },
      revit: {
        host: {
          schema: "revit-operator.active-host-model-inventory.v1",
          source: "attested_revit_install",
          process_id: 16276,
          version_year: "2024",
          sample_models: [
            {
              name: "Snowdon Towers Sample HVAC.rvt",
              path: "C:\\Program Files\\Autodesk\\Revit 2024\\Samples\\Snowdon Towers Sample HVAC.rvt",
              version_year: "2024"
            }
          ],
          require_active_version_match: true
        },
        document: {
          title: "",
          path: ""
        }
      }
    }
  };

  const prompt = await __testOnlyBuildPromptForRequest(request);
  assert.match(prompt, /Revit model-open path rule/);
  assert.match(prompt, /Never guess another installed Revit year's sample path/);
  assert.match(prompt, /Snowdon Towers Sample HVAC\.rvt/);
  assert.match(prompt, /Revit 2024\\\\Samples/);
  assert.doesNotMatch(prompt, /Revit 2026\\\\Samples/);
});
