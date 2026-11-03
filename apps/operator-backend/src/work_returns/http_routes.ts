import type http from "node:http";

import { getGoal } from "../goals/service.js";
import { writeJson } from "../http.js";
import { renderWorkReturnMarkdown } from "./generator.js";
import { readLatestWorkReturn } from "./store.js";
import {AssignmentJournalV2} from '../domain/assignment-kernel/index.js';
import {workReturnTerminalPresentationV2} from './terminal_presentation.js';

export function handleWorkReturnHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  authorizeSession: (sessionId: string) => boolean
): boolean {
  const match = url.pathname.match(/^\/api\/assignments\/([^/]+)\/work-return$/);
  if (req.method !== "GET" || !match) return false;
  const assignmentId = decodeURIComponent(match[1] || "").trim().replace(/^goal:/, "").slice(0, 240);
  if (!assignmentId) {
    writeJson(res, 400, { error: "assignment id is required." });
    return true;
  }
  const goal = getGoal(assignmentId);
  if (!goal) {
    writeJson(res, 404, { error: "Assignment not found." });
    return true;
  }
  if (goal.related_session_id && !authorizeSession(goal.related_session_id)) return true;
  try {
    const journal=goal.assignment_kernel_v2;
    const snapshot=journal?.schema==='revit-operator.assignment-kernel-journal/v2'&&Array.isArray(journal.events)&&journal.events.length
      ?new AssignmentJournalV2(journal.events).snapshot():null;
    const persisted = readLatestWorkReturn(goal,snapshot??undefined);
    if (url.searchParams.get("format") === "markdown") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/markdown; charset=utf-8");
      res.setHeader("cache-control", "private, no-store");
      res.end(renderWorkReturnMarkdown(persisted.work_return));
      return true;
    }
    const presentation=workReturnTerminalPresentationV2(snapshot,persisted.work_return);
    writeJson(res, 200, { ok: true, ...persisted,...(presentation?{terminal_result_presentation:presentation}:{}) });
  } catch (error) {
    writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
