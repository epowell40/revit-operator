import OpenAI from "openai";

export function resolveOpenAiApiKey(): string {
  return (process.env.OPERATOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

export function createOpenAiClient(apiKey?: string): OpenAI {
  const resolvedApiKey = (apiKey || resolveOpenAiApiKey()).trim();
  const baseURL = (process.env.OPERATOR_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
  const organization = (process.env.OPERATOR_OPENAI_ORG || process.env.OPENAI_ORG || "").trim();
  const project = (process.env.OPERATOR_OPENAI_PROJECT || process.env.OPENAI_PROJECT || "").trim();

  return new OpenAI({
    apiKey: resolvedApiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {})
  });
}
