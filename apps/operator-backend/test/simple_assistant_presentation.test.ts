import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renderResultDeliveryV2 } from "../src/domain/assignment-kernel/result_delivery.js";

const root = ["../packages/operator-assistant-ui", "../../packages/operator-assistant-ui"].map(p => path.resolve(p))
  .find(p => fs.existsSync(path.join(p, "conversation_ui.mjs")))!;
const ui = await import(pathToFileURL(path.join(root, "conversation_ui.mjs")).href);
const intake = await import(pathToFileURL(path.join(root, "composer_intake.mjs")).href);

test("C55 canonical short delivery reaches the actual UI as one answer plus closed supporting details",()=>{
  const document:any={createTextNode:(text:string)=>({tag:"text",textContent:text}),createElement:(tag:string)=>({tag,children:[] as any[],ownerDocument:document,textContent:"",
    appendChild(child:any){this.children.push(child);},replaceChildren(){this.children=[];}})};
  const flatten=(node:any):any[]=>[node,...(node.children??[]).flatMap(flatten)];
  const fixtures=JSON.parse(fs.readFileSync("test/fixtures/conversation_delivery.v1.json","utf8"));
  for(const {id,delivery} of fixtures.cases){
    const container=document.createElement("div");
    for(let restore=0;restore<2;restore++){
      ui.renderAssistantBlocks(container,renderResultDeliveryV2(delivery));
      assert.equal(container.children.filter((n:any)=>n.tag==="details").length,1,id);
      const details=container.children.at(-1);assert.equal(details.tag,"details");assert.equal(details.open,undefined);
      assert.equal(details.children[0].textContent,"Details");
      const visible=container.children.filter((n:any)=>n.tag!=="details");
      assert.deepEqual(visible.map((n:any)=>n.tag),[id==="resumed-three-bullet-review"?"ul":"p"]);
      if(id==="resumed-three-bullet-review")assert.equal(visible[0].children.length,3);
      const detailText=flatten(details).map(n=>n.textContent??"").join(" ");
      for(const limitation of delivery.assessment.limitations)assert.ok(detailText.includes(limitation));
      assert.ok(detailText.includes(delivery.items[0].label));
    }
  }
  const container=document.createElement("div");
  ui.renderAssistantBlocks(container,"Answer.\n\n## Details\n### Scope and limitations\n<img onerror=run()>\n\n### Model evidence\n- value\n\n## Questions\nWhich phase?");
  assert.deepEqual(container.children.map((n:any)=>n.tag),["p","details","h3","p"]);
  assert.equal(flatten(container).some(n=>n.tag==="img"),false);
});

test("composer intake captures file bytes once and blocks duplicate backend or pending sends without blocking computer steering", () => {
  const state: any = { pendingAttachments: [{ filename: "redline.pdf", data_base64: "bytes" }], streaming: false };
  const first = intake.beginComposerSend(state, "Review it");
  assert.equal(state.composerSubmissionPending, true);
  assert.equal(intake.beginComposerSend(state, "Duplicate"), null);
  state.pendingAttachments[0].filename = "later.pdf";
  assert.equal(first.attachments[0].filename, "redline.pdf"); assert.equal(first.attachments[0].data_base64, "bytes");
  state.composerSubmissionPending = false; state.streaming = true; state.activeRunKind = "backend";
  assert.equal(intake.beginComposerSend(state, "Duplicate active send"), null);
  state.activeRunKind = "computer"; assert.ok(intake.beginComposerSend(state, "Steer this work"));
  state.composerSubmissionPending = false; state.resetting = true; assert.equal(intake.beginComposerSend(state, "Late send"), null);
  assert.equal(intake.beginComposerSend({ pendingAttachments: [] }, "  "), null);
});

test("idle tasks cannot imply ongoing work; working summaries do not expose internal task detail", () => {
  assert.equal(ui.compactWorkSummary({ current_step: "Canonical evidence token secret-value" }, false), "");
  assert.equal(ui.compactWorkSummary({ current_step: "Verify native postcondition for internal-id-42" }, true), "Checking the result…");
  assert.equal(ui.compactWorkSummary({ current_step: "Discover current model" }, true), "Checking the model…");
  assert.equal(ui.compactWorkSummary({ current_step: "Apply parameter changes" }, true), "Making the requested changes…");
  assert.equal(ui.compactWorkSummary({ current_step: "Executing task", _projection: { execution: { requested_effect: "read" } } }, true), "Checking the model…");
  assert.equal(ui.compactWorkSummary({ current_step: "Executing task", work_budget: { requested_effect: "preview" } }, true), "Preparing a preview…");
  assert.equal(ui.compactWorkSummary({ current_step: "Executing task" }, true), "Working…");
  assert.equal(ui.conciseStatus("Sidecar ready."), "Ready");
  assert.equal(ui.conciseStatus("Revit connection lost."), "Revit connection lost.");
});

test("inline formatting treats model names and HTML as inert text", () => {
  const nodes: any[] = [];
  const document = { createElement: (tag: string) => ({ tag, textContent: "" }), createTextNode: (text: string) => ({ tag: "text", textContent: text }) };
  ui.appendInlineText({ ownerDocument: document, appendChild: (node: any) => nodes.push(node) }, "Yes — **Model A**. `<script>` <img onerror=run()>");
  assert.deepEqual(nodes.filter(n => n.tag !== "text").map(n => n.tag), ["strong", "code"]);
  assert.equal(nodes.find(n => n.tag === "strong").textContent, "Model A");
  assert.ok(nodes.some(n => n.textContent.includes("<img onerror=run()>")));
});

test("document answers render semantic headings, lists and inert code instead of a wall of markdown", () => {
  const document:any={createTextNode:(text:string)=>({tag:"text",textContent:text}),createElement:(tag:string)=>({tag,children:[] as any[],ownerDocument:document,textContent:"",
    appendChild(child:any){this.children.push(child);},replaceChildren(){this.children=[];}})};
  const root=document.createElement("div");
  ui.renderAssistantBlocks(root,"## Coverage\nBoth documents inspected.\n\n- **Page 3:** red underline.\n- No model edits.\n\n1. Check loads\n2. Ask for hours\n\n```html\n<script>run()</script>\n```");
  assert.deepEqual(root.children.map((n:any)=>n.tag),["h3","p","ul","ol","pre"]);
  assert.equal(root.children[2].children.length,2);assert.equal(root.children[3].children.length,2);
  assert.ok(root.children[2].children[0].children.some((n:any)=>n.tag==="strong"&&n.textContent==="Page 3:"));
  assert.equal(root.children[4].children[0].tag,"code");assert.equal(root.children[4].children[0].textContent,"<script>run()</script>");
  ui.renderAssistantBlocks(root,"A = Q / V (ft²).\n\nD = sqrt(4 × A / π) (ft).");
  const equations = root.children.flatMap((n:any)=>n.children).map((n:any)=>n.textContent).join(" ");
  assert.match(equations,/A = Q \/ V \(ft²\)/); assert.match(equations,/sqrt\(4 × A \/ π\)/);
  ui.renderAssistantBlocks(root,"## Replacement\nFinal only.");
  assert.deepEqual(root.children.map((n:any)=>n.tag),["h3","p"],"stream rerender replaces prior nodes");
});

test("restoring history preserves a simultaneous live reply and avoids duplicate messages", () => {
  const live = { id: "new", role: "assistant", text: "Current streaming reply" };
  const result = ui.mergeConversationHistory([live], [
    { message_id: "old", role: "user", text: "Which model?" },
    { message_id: "old", role: "assistant", text: "Pilot." },
    { message_id: "new", role: "assistant", text: "Older partial reply" },
    { message_id: "old", role: "assistant", text: "Duplicate" },
    { message_id: "internal", role: "tool", text: "hidden" }
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[2], live);
  assert.equal(result[2].text, "Current streaming reply");
});

test("assessment evidence is expandable while limitations and questions remain visible", () => {
  const document:any={createTextNode:(text:string)=>({tag:"text",textContent:text}),createElement:(tag:string)=>({tag,children:[] as any[],ownerDocument:document,textContent:"",
    appendChild(child:any){this.children.push(child);},replaceChildren(){this.children=[];}})};
  const root=document.createElement("div");
  ui.renderAssistantBlocks(root,"## Assessment\nFour rows need attention.\n\n## Not verified\n- Cause of the blank cells.\n\n## Model evidence\n- [1] Actual blank: <img onerror=run()>\n\n## Questions\n1. Which phase should govern?");
  assert.deepEqual(root.children.map((n:any)=>n.tag),["h3","p","h3","ul","details","h3","ol"]);
  const evidence=root.children[4]; assert.equal(evidence.open,undefined); assert.equal(evidence.children[0].tag,"summary");
  assert.equal(evidence.children[0].textContent,"Model evidence"); assert.equal(evidence.children[1].tag,"ul");
  assert.ok(evidence.children[1].children[0].children.some((n:any)=>n.textContent.includes("<img onerror=run()>")));
  const fence=String.fromCharCode(96).repeat(3);
  ui.renderAssistantBlocks(root,fence+"text\n## Model evidence\nkeep literal\n"+fence);
  assert.deepEqual(root.children.map((n:any)=>n.tag),["pre"],"fenced examples are not disclosure directives");
});

test("reported tables render real cells with alignment and inert values; fences and malformed tables retain text", () => {
  const document:any={createTextNode:(text:string)=>({tag:"text",textContent:text}),createElement:(tag:string)=>({tag,children:[] as any[],ownerDocument:document,textContent:"",
    appendChild(child:any){this.children.push(child);},replaceChildren(){this.children=[];}})};
  const root=document.createElement("div");
  const flatten=(node:any):any[]=>[node,...(node.children??[]).flatMap(flatten)];
  ui.renderAssistantBlocks(root,"| Duct type | Count |\n|---|---:|\n| Mitered Elbows / Taps | 2 |\n| Taps | 8 |\n| Tees | 10 |\n| **Total** | **20** |");
  assert.equal(root.children[0].className,"assistantTable");
  assert.equal(flatten(root).filter(n=>n.tag==="th").length,2);
  assert.equal(flatten(root).filter(n=>n.tag==="td").length,8);
  assert.equal(flatten(root).filter(n=>n.tag==="td")[1].className,"alignRight");
  assert.ok(flatten(root).some(n=>n.tag==="strong"&&n.textContent==="20"));
  ui.renderAssistantBlocks(root,"A | B\n:---: | ---\n`a|b` | escaped \\| value\n<img onerror=run()> | <script>bad()</script>");
  assert.equal(flatten(root).filter(n=>n.tag==="td").length,4);
  assert.ok(flatten(root).some(n=>n.tag==="code"&&n.textContent==="a|b"));
  assert.ok(flatten(root).some(n=>n.textContent==="escaped | value"));
  assert.equal(flatten(root).some(n=>["img","script"].includes(n.tag)),false);
  const fence=String.fromCharCode(96).repeat(3);
  ui.renderAssistantBlocks(root,fence+"\n| A | B |\n|---|---|\n|1|2|\n"+fence);
  assert.deepEqual(root.children.map((n:any)=>n.tag),["pre"]);
  ui.renderAssistantBlocks(root,"| A | B |\n|---|\n|1|2|");
  assert.equal(flatten(root).some(n=>n.tag==="table"),false);
  assert.ok(flatten(root).some(n=>n.textContent?.includes("| A | B |")));
  ui.renderAssistantBlocks(root,"A | B\n--- | ---\n"+Array.from({length:205},(_,i)=>`${i} | value`).join("\n"));
  assert.equal(flatten(root).filter(n=>n.tag==="td").length,400);
  assert.ok(flatten(root).some(n=>n.tag==="text"&&n.textContent.includes("204 | value")),"overflow rows stay visible as text");
});
