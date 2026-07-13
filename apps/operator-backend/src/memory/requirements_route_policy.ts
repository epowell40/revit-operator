export function requiresMemoryAuthentication(pathname: string): boolean {
  const normalized = String(pathname ?? "").trim();
  return normalized === "/memory" || normalized.startsWith("/memory/");
}
