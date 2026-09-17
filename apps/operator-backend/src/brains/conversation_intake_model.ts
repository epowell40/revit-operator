import os from "node:os";
import path from "node:path";
import { CodexAppServer } from "../codex/app_server.js";
import { prepareCertifiedCodexIsolation } from "../codex/config.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "../openai_client.js";
import { normalizeModelId, normalizeReasoningEffort } from "../speed_config.js";
import { INTAKE_INSTRUCTIONS, INTAKE_SCHEMA, type ConversationIntakeInterpreter, type IntakeInput } from "../conversation_intake.js";

// An isolated model-only process: no main-agent history, tools, project prompts,
// MCP configuration or Revit runtime. Model routing grants no execution power.
export const INTAKE_CODEX_CONFIG = {
  web_search:"disabled",model_reasoning_effort:"low",
  features:{shell_tool:false,unified_exec:false,apps:false,computer_use:false,browser_use:false,browser_use_external:false,
    view_image:false,multi_agent:false,js_repl:false,goals:false,code_mode:false,code_mode_host:false,
    workspace_dependencies:false,skill_search:false}
} as const;
const instructions={baseInstructions:INTAKE_INSTRUCTIONS,developerInstructions:"Return the structured routing decision. No tools are available or authorized in this turn."};

export class ModelConversationIntake implements ConversationIntakeInterpreter {
  private client:CodexAppServer|null=null;
  private clientRoot="";
  private busy=false;
  private completed=0;
  private idleTimer:ReturnType<typeof setTimeout>|undefined;
  private closing:Promise<void>=Promise.resolve();

  close(){
    clearTimeout(this.idleTimer);
    const client=this.client;this.client=null;this.completed=0;
    if(client){
      this.closing=Promise.all([this.closing,client.stopAndWait()]).then(()=>{});
      // The next admission awaits this same promise. A failed shutdown cannot
      // silently reopen the state directory while its previous owner survives.
      void this.closing.catch(()=>{});
    }
  }

  async interpret(input:IntakeInput,signal:AbortSignal):Promise<{value:unknown;telemetry:Record<string,unknown>;acknowledge?:()=>void}> {
    const model=normalizeModelId(process.env.OPERATOR_INTAKE_MODEL,
      normalizeModelId(process.env.OPERATOR_CODEX_MODEL??process.env.OPERATOR_OPENAI_MODEL,"gpt-5.6-sol"));
    const effort=normalizeReasoningEffort(process.env.OPERATOR_INTAKE_REASONING_EFFORT,"low");
    const brain=(process.env.OPERATOR_BRAIN??"codex").trim();
    if (brain!=="codex") {
      const key=resolveOpenAiApiKey();
      if (!key || brain==="rule")throw Error("Conversation intake model is unavailable");
      const response=await createOpenAiClient(key).responses.create({model,reasoning:{effort},store:false,
        instructions:INTAKE_INSTRUCTIONS,input:JSON.stringify(input),max_output_tokens:1400,
        text:{format:{type:"json_schema",name:"operator_conversation_intake",strict:true,schema:INTAKE_SCHEMA}}} as any,
        {signal,maxRetries:0});
      if (response.status!=="completed" || !response.output_text)throw Error("Conversation intake returned no complete decision");
      return {value:JSON.parse(response.output_text),telemetry:{provider:"responses",model,reasoning_effort:effort,usage:response.usage}};
    }
    // No per-user request waits behind another user's classifier. The normal
    // agent is the conservative fallback when this small worker is occupied.
    if (this.busy)throw Error("Conversation intake worker is busy");
    this.busy=true;clearTimeout(this.idleTimer);
    let off=()=>{};
    const abort=()=>this.close();
    signal.addEventListener("abort",abort,{once:true});
    try {
      signal.throwIfAborted();
      if(this.completed>=32)this.close();
      const workspaceRoot=ensureWorkspaceLayout().root;
      if(this.clientRoot!==workspaceRoot){this.close();this.clientRoot=workspaceRoot;}
      await this.closing;signal.throwIfAborted();
      const {cwd,codexHome}=prepareCertifiedCodexIsolation({workspaceRoot,
        isolationRoot:path.join(os.tmpdir(),"revit-operator-conversation-intake-v1")});
      const client=this.client??=new CodexAppServer({cwd,codexHome,spawnEnv:{...process.env}});
      client.setServerRequestHandler(async request=>{
        if(request.method==="currentTime/read")return {currentTimeAt:Math.floor(Date.now()/1000)};
        // Any unexpected execution request makes this classification unusable.
        this.close();throw Error("Conversation intake attempted to use an execution tool");
      });
      await client.ensureStarted();signal.throwIfAborted();
      const started=await client.startThread({model,cwd,sandbox:"read-only",approvalPolicy:"never",
        config:{...INTAKE_CODEX_CONFIG,model_reasoning_effort:effort},baseInstructions:instructions.baseInstructions,developerInstructions:instructions.developerInstructions,
        dynamicTools:[],environments:[],selectedCapabilityRoots:[],ephemeral:true});
      signal.throwIfAborted();
      if(started.model!==model)throw Error("Conversation intake model did not match the requested model");
      const threadId=started.thread.id;
      let text="",usage:unknown=null,unexpectedTool=false;
      off=client.onNotification(event=>{
        if(event.threadId!==threadId)return;
        const item=event.params?.item;
        if(event.method==="item/completed"&&item?.type==="agentMessage")text=String(item.text??"");
        if(event.method==="thread/tokenUsage/updated")usage=event.params?.tokenUsage??null;
        if(event.method==="item/started"&&item&&!["userMessage","agentMessage","reasoning","contextCompaction"].includes(item.type)) {
          unexpectedTool=true;this.close();
        }
      });
      const turn=await client.startBoundTurn({threadId,model,effort,environments:[],
        input:[{type:"text",text:JSON.stringify(input),text_elements:[]}],outputSchema:INTAKE_SCHEMA as any},instructions);
      const completed=await client.waitForTurnCompleted({threadId,turnId:turn.turn.id,timeoutMs:30_000,abortSignal:signal});
      signal.throwIfAborted();
      if(unexpectedTool||completed.status!=="completed"||!text)throw Error("Conversation intake returned no complete tool-free decision");
      const binding=client.getTurnInstructionBinding(threadId,turn.turn.id);
      return {value:JSON.parse(text),acknowledge:()=>client.acknowledgePersistedTurnInstructionBinding(threadId,turn.turn.id),
        telemetry:{provider:"codex",model,reasoning_effort:effort,thread_id:threadId,turn_id:turn.turn.id,
        host_instruction_binding:binding,usage}};
    } catch(error){this.close();throw error;}
    finally {
      off();signal.removeEventListener("abort",abort);this.busy=false;
      this.completed++;
      this.idleTimer=setTimeout(()=>this.close(),300_000);this.idleTimer.unref();
    }
  }
}

export const conversationIntakeModel=new ModelConversationIntake();
