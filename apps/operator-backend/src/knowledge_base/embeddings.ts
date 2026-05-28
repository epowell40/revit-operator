import { createHash } from "node:crypto";
import { createOpenAiClient, resolveOpenAiApiKey } from "../openai_client.js";
import { readKnowledgeBaseConfig } from "./config.js";

export type EmbeddingProvider = {
  embedTexts: (texts: string[]) => Promise<number[][]>;
  embedQuery: (text: string) => Promise<number[]>;
};

function normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (mag <= 0) return v;
  return v.map(x => x / mag);
}

function localHashEmbedding(text: string, dims = 256): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = (text ?? "").toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    for (let i = 0; i < 4; i++) {
      const idx = digest.readUInt16BE(i * 2) % dims;
      const sign = (digest[i + 8] & 1) === 0 ? 1 : -1;
      vec[idx] += sign;
    }
  }
  return normalize(vec);
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const cfg = readKnowledgeBaseConfig();
  const provider = cfg.embeddingProvider.toLowerCase();

  if (provider === "openai") {
    return {
      async embedTexts(texts: string[]): Promise<number[][]> {
        const key = resolveOpenAiApiKey();
        if (!key) throw new Error("KB_EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not configured.");
        const client = createOpenAiClient(key);
        const r = await client.embeddings.create({ model: cfg.embeddingModel, input: texts });
        return r.data.map(x => normalize(x.embedding as number[]));
      },
      async embedQuery(text: string): Promise<number[]> {
        const [v] = await this.embedTexts([text]);
        return v ?? localHashEmbedding(text);
      }
    };
  }

  return {
    async embedTexts(texts: string[]): Promise<number[][]> {
      return texts.map(t => localHashEmbedding(t));
    },
    async embedQuery(text: string): Promise<number[]> {
      return localHashEmbedding(text);
    }
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
