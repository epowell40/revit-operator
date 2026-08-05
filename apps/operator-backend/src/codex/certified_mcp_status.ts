export function assertCertifiedMcpServerStatus(status: unknown): void {
  const record = status && typeof status === "object" && !Array.isArray(status) ? status as Record<string, unknown> : null;
  const isOwn = (key: string) => !!record && Object.prototype.hasOwnProperty.call(record, key);
  const keysAreProtocolBacked = !!record && Reflect.ownKeys(record).every(key => key === "data" || key === "nextCursor");
  if (!record || !keysAreProtocolBacked || !isOwn("data") || !Array.isArray(record.data) || (isOwn("nextCursor") && record.nextCursor !== null)) {
    throw new Error("Certified Codex MCP status is unavailable or malformed.");
  }
  const entries = record.data;
  if (entries.length === 0) return;
  const labels = entries.slice(0, 4).map(entry => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return typeof item.name === "string" ? item.name : typeof item.id === "string" ? item.id : "unknown";
  });
  throw new Error(`Certified Codex startup refused configured MCP servers: ${labels.join(", ")}.`);
}
