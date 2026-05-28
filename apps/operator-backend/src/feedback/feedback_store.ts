import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";
import { appendDailyMemory, appendLongtermMemory } from "../memory/jsonl_memory_store.js";
import { queueRunBundleForUpload } from "./upload_queue.js";
import { buildDevHandoff, type DevHandoff } from "./dev_handoff.js";

export type FeedbackRating = "worked" | "partial" | "failed";

export type FeedbackEvent = {
  session_id: string;
  chat_id: string | null;
  rating: FeedbackRating;
  note: string | null;
  remember_preference: boolean;
  queue_upload: boolean;
  created_at: string;
  dev_handoff?: DevHandoff;
};

export type FeedbackPersistResult = {
  ok: true;
  created_at: string;
  feedback_events_path: string;
  dev_handoff: DevHandoff;
  memory_daily_path?: string;
  memory_longterm_path?: string;
  upload_queue_dir?: string;
  upload_queue_link_kind?: "junction" | "pointer";
};

function nowIso(): string {
  return new Date().toISOString();
}

function isRating(x: string): x is FeedbackRating {
  return x === "worked" || x === "partial" || x === "failed";
}

export function appendFeedbackAndMaybePromote(args: {
  session_id: string;
  chat_id?: string | null;
  rating: string;
  note?: string | null;
  remember_preference?: boolean;
  queue_upload?: boolean;
  created_at?: string;
}): FeedbackPersistResult {
  const layout = ensureWorkspaceLayout();

  const session_id = (args.session_id ?? "").toString().trim();
  if (!session_id) throw new Error("Missing session_id");

  const ratingRaw = (args.rating ?? "").toString().trim().toLowerCase();
  if (!isRating(ratingRaw)) throw new Error("rating must be one of: worked|partial|failed");

  const created_at = (args.created_at ?? nowIso()).toString();
  const chat_id = args.chat_id ? String(args.chat_id).trim() : "";
  const note = args.note ? String(args.note).trim() : "";
  const remember_preference = !!args.remember_preference;
  const queue_upload = !!args.queue_upload;
  const dev_handoff = buildDevHandoff({
    session_id,
    chat_id: chat_id || null,
    rating: ratingRaw,
    note: note || null
  });

  const evt: FeedbackEvent = {
    session_id,
    chat_id: chat_id || null,
    rating: ratingRaw,
    note: note || null,
    remember_preference,
    queue_upload,
    created_at,
    dev_handoff
  };

  const eventsPath = path.join(layout.feedback, "events.jsonl");
  atomicAppendJsonlLine(eventsPath, evt);

  let memory_daily_path: string | undefined;
  let memory_longterm_path: string | undefined;
  if (note) {
    try {
      memory_daily_path = appendDailyMemory({
        kind: remember_preference ? "preference" : "note",
        text: note,
        session_id,
        source: "feedback",
        ts: created_at,
        tags: remember_preference ? ["preference", "feedback", ratingRaw] : ["feedback", ratingRaw]
      });
    } catch {
      // ignore
    }
  }
  if (remember_preference && note) {
    try {
      memory_longterm_path = appendLongtermMemory({
        kind: "preference",
        text: note,
        session_id,
        source: "feedback",
        ts: created_at,
        tags: ["preference", "feedback", ratingRaw]
      });
    } catch {
      // ignore
    }
  }

  let upload_queue_dir: string | undefined;
  let upload_queue_link_kind: "junction" | "pointer" | undefined;
  if (queue_upload) {
    const r = queueRunBundleForUpload({ session_id, created_at, note: note || null });
    if (r.ok) {
      upload_queue_dir = r.queue_dir_rel;
      upload_queue_link_kind = r.link_kind;
    }
  }

  // Ensure folder exists even if nobody uses it yet.
  try {
    fs.mkdirSync(layout.feedbackUploadQueue, { recursive: true });
  } catch {
    // ignore
  }

  return {
    ok: true,
    created_at,
    feedback_events_path: eventsPath,
    dev_handoff,
    ...(memory_daily_path ? { memory_daily_path } : {}),
    ...(memory_longterm_path ? { memory_longterm_path } : {}),
    ...(upload_queue_dir ? { upload_queue_dir } : {}),
    ...(upload_queue_link_kind ? { upload_queue_link_kind } : {})
  };
}

