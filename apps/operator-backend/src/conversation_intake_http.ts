import type { IncomingMessage, ServerResponse } from "node:http";
import { routeConversation, type ConversationIntakeInterpreter } from "./conversation_intake.js";
import { conversationIntakeModel } from "./brains/conversation_intake_model.js";

export async function handleConversationIntakeHttp(req:IncomingMessage,res:ServerResponse,deps:{
  readJson:(request:IncomingMessage,limit:number)=>Promise<unknown>;
  authorized:(sessionId:string)=>boolean;
  respond:(status:number,body:unknown)=>unknown;
  interpreter?:ConversationIntakeInterpreter;
}) {
  const controller=new AbortController();
  const close=()=>{if(!res.writableEnded)controller.abort();};
  res.once("close",close);
  try {
    const body=await deps.readJson(req,80_000) as Record<string,any>|null;
    if(!body||typeof body.session_id!=="string"||!body.session_id.trim()||body.session_id.length>200)
      return deps.respond(400,{error:"A valid conversation is required."});
    if(!deps.authorized(body.session_id))return;
    const decision=await routeConversation(body,deps.interpreter??conversationIntakeModel,{signal:controller.signal});
    if(!controller.signal.aborted)return deps.respond(200,decision);
  }catch(error){
    if(!controller.signal.aborted)return deps.respond(400,{error:error instanceof Error?error.message:"Invalid conversation request."});
  }finally{res.removeListener("close",close);}
}
