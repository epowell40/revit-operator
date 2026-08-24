export const OPERATOR_BACKEND_AUTH_V1 = "revit-operator.operator-backend-auth/v1" as const;
export const OPERATOR_BACKEND_AUTH_META_KEY = "revit-operator/backend-auth" as const;

export type OperatorBackendAuthMode = "shared_token" | "principal_jwt";

export type OperatorBackendAuthV1 = {
  schema: typeof OPERATOR_BACKEND_AUTH_V1;
  mode: OperatorBackendAuthMode;
  credential: string;
  allowed_origin: string;
};

function normalizeOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Operator backend origin must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Operator backend origin must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Operator backend origin must not contain URL credentials.");
  }
  return parsed.origin;
}

export function configuredOperatorBackendOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.OPERATOR_API_BASE_URL || "http://127.0.0.1:7007").trim();
  return normalizeOrigin(configured);
}

export function createOperatorBackendAuth(
  mode: OperatorBackendAuthMode,
  credential: string,
  env: NodeJS.ProcessEnv = process.env
): OperatorBackendAuthV1 {
  const boundedCredential = credential.trim();
  if (!boundedCredential || boundedCredential.length > 32_768) {
    throw new Error("Authenticated Operator backend credential is missing or invalid.");
  }
  return Object.freeze({
    schema: OPERATOR_BACKEND_AUTH_V1,
    mode,
    credential: boundedCredential,
    allowed_origin: configuredOperatorBackendOrigin(env)
  });
}

export function operatorBackendAuthRequestMeta(auth: OperatorBackendAuthV1): Record<string, unknown> {
  return { [OPERATOR_BACKEND_AUTH_META_KEY]: auth };
}
