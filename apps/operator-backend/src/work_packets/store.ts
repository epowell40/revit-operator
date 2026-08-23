import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GoalRecord } from "../goals/service.js";
import { ensureWorkspaceLayout, resolveFileUnderWorkspace } from "../workspace.js";
import type { PersistedVerifiedWorkPacket, VerifiedWorkPacketV1 } from "./contract.js";
import { generateVerifiedWorkPacket, verifyVerifiedWorkPacketHash } from "./generator.js";
import { renderVerifiedWorkPacketMarkdown } from "./renderer.js";

function assignmentSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new Error("Assignment id is unsafe for packet persistence.");
  return value;
}

function packetDirectory(assignmentId: string): string {
  return resolveFileUnderWorkspace(path.posix.join("artifacts", "goals", assignmentSegment(assignmentId), "verified-work-packets"));
}

function writeImmutable(filePath: string, bytes: Buffer): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, bytes, { flag: "wx", mode: 0o600 });
    try {
      fs.linkSync(tempPath, filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!fs.readFileSync(filePath).equals(bytes)) throw new Error("Immutable Verified Work Packet collision.");
      return false;
    }
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

function sourceEquivalent(left: VerifiedWorkPacketV1, right: VerifiedWorkPacketV1): boolean {
  const strip = (packet: VerifiedWorkPacketV1) => {
    const { packet_id: _id, packet_hash: _hash, parent_packet_id: _parent, ...body } = packet;
    return canonical(body);
  };
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

function readPackets(assignmentId: string): VerifiedWorkPacketV1[] {
  const directory = packetDirectory(assignmentId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^vwp1_[A-Za-z0-9_-]{32}\.json$/.test(entry.name))
    .flatMap(entry => {
      try {
        const packet = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8")) as VerifiedWorkPacketV1;
        return verifyVerifiedWorkPacketHash(packet) && packet.identity.assignment_id === assignmentId ? [packet] : [];
      } catch { return []; }
    })
    .sort((left, right) => left.identity.created_at.localeCompare(right.identity.created_at) || left.packet_id.localeCompare(right.packet_id));
}

function latestPacket(packets: VerifiedWorkPacketV1[]): VerifiedWorkPacketV1 | null {
  const parents = new Set(packets.map(packet => packet.parent_packet_id).filter((value): value is string => Boolean(value)));
  return packets.filter(packet => !parents.has(packet.packet_id)).at(-1) ?? packets.at(-1) ?? null;
}

function relativeWorkspacePath(filePath: string): string {
  return path.relative(ensureWorkspaceLayout().root, filePath).split(path.sep).join("/");
}

export function persistVerifiedWorkPacket(goal: GoalRecord): PersistedVerifiedWorkPacket {
  const existing = readPackets(goal.id);
  const unparented = generateVerifiedWorkPacket(goal, null);
  const equivalent = [...existing].reverse().find(packet => sourceEquivalent(packet, unparented));
  const packet = equivalent ?? generateVerifiedWorkPacket(goal, latestPacket(existing)?.packet_id ?? null);
  const directory = packetDirectory(goal.id);
  const jsonPath = path.join(directory, `${packet.packet_id}.json`);
  const markdownPath = path.join(directory, `${packet.packet_id}.md`);
  const jsonBytes = Buffer.from(`${JSON.stringify(packet, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(renderVerifiedWorkPacketMarkdown(packet), "utf8");
  const jsonCreated = writeImmutable(jsonPath, jsonBytes);
  const markdownCreated = writeImmutable(markdownPath, markdownBytes);
  return {
    packet,
    json_path: relativeWorkspacePath(jsonPath),
    markdown_path: relativeWorkspacePath(markdownPath),
    created: jsonCreated || markdownCreated
  };
}

export function readLatestVerifiedWorkPacket(goal: GoalRecord): PersistedVerifiedWorkPacket {
  return persistVerifiedWorkPacket(goal);
}

export function listVerifiedWorkPackets(assignmentId: string): VerifiedWorkPacketV1[] {
  return readPackets(assignmentId);
}
