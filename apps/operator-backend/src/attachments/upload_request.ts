import type { AttachmentUploadInput } from "./upload_store.js";

type UploadRequestBody = {
  id?: unknown;
  filename?: unknown;
  file_name?: unknown;
  relative_path?: unknown;
  relativePath?: unknown;
  sha256?: unknown;
  mime?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  data_base64?: unknown;
  dataBase64?: unknown;
};

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function attachmentUploadSessionId(body: UploadRequestBody): string | undefined {
  return trimmedString(body.session_id) ?? trimmedString(body.sessionId);
}

export function parseAttachmentUploadInput(body: UploadRequestBody): AttachmentUploadInput {
  return {
    id: trimmedString(body.id),
    filename: trimmedString(body.filename) ?? trimmedString(body.file_name),
    relative_path: trimmedString(body.relative_path) ?? trimmedString(body.relativePath),
    sha256: trimmedString(body.sha256),
    mime: trimmedString(body.mime),
    created_at: trimmedString(body.created_at) ?? trimmedString(body.createdAt),
    session_id: attachmentUploadSessionId(body),
    data_base64: typeof body.data_base64 === "string"
      ? body.data_base64
      : typeof body.dataBase64 === "string"
        ? body.dataBase64
        : ""
  };
}
