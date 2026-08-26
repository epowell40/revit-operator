import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  replayProviderProgressV2,
  type AssignmentEventV2,
  type ProviderReceiptForReplayV2
} from "../domain/assignment-kernel/index.js";

interface GoalEnvelopeV2 {
  assignment_kernel_v2?: { events?: AssignmentEventV2[] };
}

interface ChatResultEnvelopeV2 {
  response?: {
    model_call_receipts?: Array<{
      call_id?: unknown;
      tokens?: { total_tokens?: unknown };
    }>;
  };
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return path.resolve(value);
}

function parseJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function providerReceipts(chat: ChatResultEnvelopeV2): ProviderReceiptForReplayV2[] {
  return (chat.response?.model_call_receipts ?? []).flatMap((receipt) => {
    if (typeof receipt.call_id !== "string" || receipt.call_id.length === 0) return [];
    return [{
      call_id: receipt.call_id,
      total_tokens: typeof receipt.tokens?.total_tokens === "number" ? receipt.tokens.total_tokens : null
    }];
  });
}

const goalPath = arg("--goal");
const chatPath = arg("--chat-result");
const outputPath = arg("--output");
const goal = parseJson<GoalEnvelopeV2>(goalPath);
const chat = parseJson<ChatResultEnvelopeV2>(chatPath);
const events = goal.assignment_kernel_v2?.events;
if (!Array.isArray(events) || events.length === 0) throw new Error("Goal does not contain an Assignment Kernel V2 journal.");
const replay = replayProviderProgressV2({
  events,
  provider_receipts: providerReceipts(chat),
  source_evidence: {
    event_journal_sha256: sha256(goalPath),
    provider_receipts_sha256: sha256(chatPath)
  }
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(replay, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${outputPath}\n`);
