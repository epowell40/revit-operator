// Pinned app-server code mode serializes multimodal tool results as text blocks
// and standalone data URLs. Source-document strings remain JSON escaped.
export const CODE_MODE_IMAGE_DISPLAY = String.raw`const output = String(result);
const toolImage = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const textLines = [];
for (const line of output.split("\n")) {
  if (toolImage.test(line)) image(line, "original");
  else textLines.push(line);
}
text(textLines.join("\n").slice(0, 48000));`;

export const CODE_MODE_IMAGE_GUIDANCE = "In code mode, the returned value is a string, not an MCP content object. Keep the result of the same call and display its standalone PNG/JPEG/WebP image URLs with image(..., 'original'). Do not print or JSON.stringify the raw result: that dumps image base64 and can truncate evidence. Do not call the tool again just to display the returned image. After assigning the call result to `result`, use:\n" + CODE_MODE_IMAGE_DISPLAY;

const IMAGE_RESULT_TOOLS = new Set(["revit_call_tool", "revit_export_view_frame"]);

export function describeCodeModeImageTool(name: string, description: string): string {
  return IMAGE_RESULT_TOOLS.has(name)
    ? `${description} Image-producing view exports can return actual image bytes alongside metadata. ${CODE_MODE_IMAGE_GUIDANCE}`
    : description;
}
