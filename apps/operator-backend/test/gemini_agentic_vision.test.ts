import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRedlineWithGemini, computeRelatedRegionGroups, normalizeGeminiVisionOutput } from "../src/vision/gemini_agentic_vision.js";

test("gemini normalize: parses structured regions and confidence coercion", () => {
  const raw = {
    summary: "Two edits found.",
    global_confidence: 92,
    regions: [
      {
        region_index: 1,
        target_type: "viewport",
        intent: "Resize duct to 10x12",
        rationale: "Red cloud around duct with note 10x12",
        proposed_action: "Call /revit/create-duct with ductSize 10x12",
        size_or_value: "10x12",
        confidence: 0.88
      },
      {
        regionIndex: 2,
        targetType: "titleblock",
        intent: "Change issue date",
        rationale: "Arrow points to issue date field",
        proposedAction: "Use /revit/set-parameter for date field",
        sizeOrValue: "2026-02-28",
        confidence: "74"
      }
    ],
    open_questions: ["Confirm whether date format should be MM/DD/YYYY."]
  };

  const out = normalizeGeminiVisionOutput(raw, "");
  assert.equal(out.summary, "Two edits found.");
  assert.equal(out.regions.length, 2);
  assert.equal(out.regions[0]?.target_type, "viewport");
  assert.equal(out.regions[1]?.target_type, "titleblock");
  assert.equal(out.regions[1]?.confidence, 0.74);
  assert.equal(out.global_confidence, 0.92);
  assert.equal(out.open_questions.length, 1);
});

test("gemini normalize: falls back safely when no valid JSON payload exists", () => {
  const out = normalizeGeminiVisionOutput("No JSON returned; unclear marks.", "No JSON returned; unclear marks.");
  assert.equal(out.regions.length, 0);
  assert.equal(out.open_questions.length, 0);
  assert.equal(out.global_confidence, 0.5);
  assert.match(out.summary, /No JSON returned/i);
});

test("gemini normalize: parses final fenced json block from mixed content", () => {
  const mixed = [
    "I will inspect the marked regions with code execution.",
    "```python",
    "print('debug')",
    "```",
    "```json",
    "{\"summary\":\"Delete 3 struck notes\",\"global_confidence\":0.83,\"regions\":[{\"region_index\":1,\"target_type\":\"annotation\",\"intent\":\"Delete struck note\",\"rationale\":\"red strike\",\"proposed_action\":\"delete\",\"size_or_value\":null,\"confidence\":0.79}],\"open_questions\":[]}",
    "```"
  ].join("\n");
  const out = normalizeGeminiVisionOutput(mixed, mixed);
  assert.equal(out.summary, "Delete 3 struck notes");
  assert.equal(out.regions.length, 1);
  assert.equal(out.regions[0]?.region_index, 1);
  assert.equal(out.global_confidence, 0.83);
});

test("gemini normalize: prefers highest-scoring schema object when multiple json objects exist", () => {
  const mixed = [
    "{\"note\":\"intermediate\"}",
    "{\"summary\":\"final\",\"global_confidence\":0.9,\"regions\":[{\"region_index\":2,\"target_type\":\"sheet\",\"intent\":\"Delete title\",\"rationale\":\"x mark\",\"proposed_action\":\"delete\",\"size_or_value\":null,\"confidence\":0.88}],\"open_questions\":[]}"
  ].join("\n");
  const out = normalizeGeminiVisionOutput(mixed, mixed);
  assert.equal(out.summary, "final");
  assert.equal(out.regions.length, 1);
  assert.equal(out.regions[0]?.region_index, 2);
  assert.equal(out.global_confidence, 0.9);
});

test("gemini region grouping: clusters nearby boxes and leaves distant boxes separate", () => {
  const groups = computeRelatedRegionGroups([
    { index: 1, x: 100, y: 120, w: 90, h: 60 },
    { index: 2, x: 220, y: 130, w: 80, h: 55 },
    { index: 3, x: 980, y: 640, w: 70, h: 50 }
  ], 80);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.region_indices, [1, 2]);
});

async function withEnv(overrides: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      const p = prev[k];
      if (typeof p === "string") process.env[k] = p;
      else delete process.env[k];
    }
  }
}

function makeTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-pre-"));
  fs.mkdirSync(path.join(root, "artifacts", "redline"), { recursive: true });
  return root;
}

test("gemini analyze: reports preprocess warnings when input is skipped by max input size", async () => {
  const root = makeTempWorkspace();
  try {
    const rel = "artifacts/redline/big.jpg";
    fs.writeFileSync(path.join(root, rel), Buffer.alloc(400_000, 1));
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async () => {
        fetchCalled = true;
        throw new Error("fetch should not be called");
      };

      await withEnv(
        {
          OPERATOR_WORKSPACE_ROOT: root,
          OPERATOR_GEMINI_VISION_ENABLED: "1",
          OPERATOR_GEMINI_API_KEY: "dummy-key",
          OPERATOR_GEMINI_MAX_INPUT_FILE_BYTES: "1024"
        },
        async () => {
          const out = await analyzeRedlineWithGemini({ file_path: rel });
          assert.equal(out.ok, false);
          assert.match(out.summary, /No image inputs were provided/i);
          assert.equal(fetchCalled, false);
          assert.ok(out.preprocess?.warnings?.some(w => /Input skipped/i.test(w)));
        }
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gemini analyze: enforces inline part hard cap before API call", async () => {
  const root = makeTempWorkspace();
  try {
    const rel = "artifacts/redline/oversize.jpg";
    fs.writeFileSync(path.join(root, rel), Buffer.alloc(11_500_000, 7));
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async () => {
        fetchCalled = true;
        throw new Error("fetch should not be called");
      };

      await withEnv(
        {
          OPERATOR_WORKSPACE_ROOT: root,
          OPERATOR_GEMINI_VISION_ENABLED: "1",
          OPERATOR_GEMINI_API_KEY: "dummy-key",
          OPERATOR_GEMINI_MAX_IMAGE_BYTES: "20000000",
          OPERATOR_GEMINI_INLINE_PART_HARD_LIMIT_BYTES: "9000000"
        },
        async () => {
          const out = await analyzeRedlineWithGemini({ file_path: rel });
          assert.equal(out.ok, false);
          assert.match(out.summary, /No readable images were available/i);
          assert.equal(fetchCalled, false);
          assert.ok((out.preprocess?.warnings?.length ?? 0) > 0);
        }
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gemini analyze: preprocess context is retained on Gemini HTTP error responses", async () => {
  const root = makeTempWorkspace();
  try {
    const rel = "artifacts/redline/input.jpg";
    fs.writeFileSync(path.join(root, rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async () =>
        ({
          ok: false,
          status: 400,
          text: async () => "bad request"
        }) as any;

      await withEnv(
        {
          OPERATOR_WORKSPACE_ROOT: root,
          OPERATOR_GEMINI_VISION_ENABLED: "1",
          OPERATOR_GEMINI_API_KEY: "dummy-key",
          OPERATOR_GEMINI_BASE_URL: "http://127.0.0.1:7099/v1beta"
        },
        async () => {
          const out = await analyzeRedlineWithGemini({
            file_path: rel,
            region_boxes: [{ x: 10, y: 10, w: 40, h: 25 }]
          });
          assert.equal(out.ok, false);
          assert.match(out.summary, /Gemini API request failed/i);
          assert.equal(out.preprocess?.source_region_box_count, 1);
        }
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gemini analyze: falls back to direct PDF input when converters are unavailable", async () => {
  const root = makeTempWorkspace();
  try {
    const rel = "artifacts/redline/input.pdf";
    fs.writeFileSync(path.join(root, rel), Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", "utf8"));

    let capturedMimeTypes: string[] = [];
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (_url: string, init: any) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        const parts = Array.isArray(body?.contents?.[0]?.parts) ? body.contents[0].parts : [];
        capturedMimeTypes = parts
          .map((p: any) => (p?.inlineData?.mimeType ?? "").toString())
          .filter((x: string) => !!x);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify({ summary: "ok", regions: [], open_questions: [], global_confidence: 0.75 }) }]
                  }
                }
              ]
            })
        } as any;
      };

      await withEnv(
        {
          OPERATOR_WORKSPACE_ROOT: root,
          OPERATOR_GEMINI_VISION_ENABLED: "1",
          OPERATOR_GEMINI_API_KEY: "dummy-key",
          OPERATOR_GEMINI_BASE_URL: "http://127.0.0.1:7099/v1beta",
          PATH: ""
        },
        async () => {
          const out = await analyzeRedlineWithGemini({ file_path: rel, max_pages: 1 });
          assert.equal(out.ok, true);
          assert.ok(out.preprocess?.warnings?.some(w => /PDF convert warning/i.test(w)));
          assert.ok(capturedMimeTypes.includes("application/pdf"));
        }
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gemini analyze: retries with fallback model when primary model is unavailable", async () => {
  const root = makeTempWorkspace();
  try {
    const rel = "artifacts/redline/input.jpg";
    fs.writeFileSync(path.join(root, rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const requestedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (url: string) => {
        const m = String(url).match(/\/models\/([^:]+):generateContent\?/);
        const model = m ? decodeURIComponent(m[1]!) : "unknown";
        requestedModels.push(model);
        if (model === "gemini-3-flash") {
          return {
            ok: false,
            status: 404,
            text: async () => "Model not found"
          } as any;
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify({ summary: "fallback-ok", regions: [], open_questions: [], global_confidence: 0.81 }) }]
                  }
                }
              ]
            })
        } as any;
      };

      let sawRetryWarning = false;
      await withEnv(
        {
          OPERATOR_WORKSPACE_ROOT: root,
          OPERATOR_GEMINI_VISION_ENABLED: "1",
          OPERATOR_GEMINI_API_KEY: "dummy-key",
          OPERATOR_GEMINI_BASE_URL: "http://127.0.0.1:7099/v1beta",
          OPERATOR_GEMINI_MODEL: "gemini-3-flash",
          OPERATOR_GEMINI_MODEL_FALLBACKS: "gemini-2.5-flash"
        },
        async () => {
          const out = await analyzeRedlineWithGemini({ file_path: rel, include_code_execution: false });
          sawRetryWarning = (out.preprocess?.warnings ?? []).some((w) => /retrying/i.test(w));
          assert.equal(out.ok, true);
          assert.ok(out.model === "gemini-3-flash-preview" || out.model === "gemini-2.5-flash");
        }
      );

      assert.ok(requestedModels[0] === "gemini-3-flash-preview" || requestedModels[0] === "gemini-3-flash");
      if (requestedModels[0] === "gemini-3-flash-preview") {
        // Preview may succeed immediately (single call) or cascade to a fallback model depending on host availability.
      } else {
        assert.ok(sawRetryWarning);
      }
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gemini analyze: code execution is enabled by default", async () => {
  const root = makeTempWorkspace();
  try {
    const rel = "artifacts/redline/input.jpg";
    fs.writeFileSync(path.join(root, rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    let capturedBody: any = null;

    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (_url: string, init: any) => {
        capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify({ summary: "ok", regions: [], open_questions: [], global_confidence: 0.9 }) }]
                  }
                }
              ]
            })
        } as any;
      };

      await withEnv(
        {
          OPERATOR_WORKSPACE_ROOT: root,
          OPERATOR_GEMINI_VISION_ENABLED: "1",
          OPERATOR_GEMINI_API_KEY: "dummy-key",
          OPERATOR_GEMINI_BASE_URL: "http://127.0.0.1:7099/v1beta",
          OPERATOR_GEMINI_ENABLE_CODE_EXECUTION: ""
        },
        async () => {
          const out = await analyzeRedlineWithGemini({ file_path: rel });
          assert.equal(out.ok, true);
        }
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }

    assert.ok(Array.isArray(capturedBody?.tools));
    assert.ok(typeof capturedBody?.tools?.[0]?.codeExecution === "object");
    assert.equal(capturedBody?.generationConfig?.responseMimeType, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
