import http from "node:http";
import zlib from "node:zlib";

const JSON_COMPRESSION_THRESHOLD_BYTES = 16 * 1024;

export async function readJson(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("Request too large");
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw) as unknown;
}

export function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  const jsonBytes = Buffer.byteLength(json);
  const acceptEncoding = `${res.req?.headers["accept-encoding"] || ""}`;
  const gzipAccepted = /(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0+)?(?:\s|,|$))[^,]*)?(?:\s*,|$)/i.test(acceptEncoding);
  const compressed = gzipAccepted && jsonBytes >= JSON_COMPRESSION_THRESHOLD_BYTES
    ? zlib.gzipSync(json, { level: 6 })
    : null;
  const payload = compressed && compressed.length < jsonBytes ? compressed : json;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("vary", "Accept-Encoding");
  if (payload === compressed) res.setHeader("content-encoding", "gzip");
  res.setHeader("content-length", typeof payload === "string" ? jsonBytes : payload.length);
  res.end(payload);
}

