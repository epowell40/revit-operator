export const TEXT_NOTE_ROUND_TRIP_V1_SCHEMA = "revit-operator.text-note-round-trip/v1";

export function normalizeTextNoteTextV1(value) {
  if (typeof value !== "string") throw new TypeError("TextNote content must be a string.");
  let normalized = value;
  if (normalized.includes("\\n") || normalized.includes("\\r")) {
    normalized = normalized.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
  }
  return normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function textNoteRoundTripMatchesV1(requested, actual) {
  const requestedNormalized = normalizeTextNoteTextV1(requested);
  const actualNormalized = normalizeTextNoteTextV1(actual);
  return actualNormalized === requestedNormalized || actualNormalized === `${requestedNormalized}\n`;
}
