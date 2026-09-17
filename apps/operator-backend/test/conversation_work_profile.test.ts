import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeConversation } from "../src/conversation_intake.js";
import { conversationWorkProfile } from "../src/brains/conversation_work_profile.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

test("semantic inspect receipt lowers bounded-question effort without keyword routing or changing authority", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-work-profile-"));
  const prior=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__closeForTests();
  try {
    const base:any={version:"operator.backend.v1",session_id:"owned",message_id:"question",user_text:"Is this the mechanical model?",
      context:{ui:{speed_settings:{speed_mode:true,agent_model:"gpt-5.6-sol",agent_reasoning_effort:"medium"}}}};
    const inspect={route:"inspect",answer:null,question_kind:"current_model",identity_fields:[],read_evidence:"model_content",basis:"needs_tools",requested_effect:"read",entire_request_answered:false,confidence:0.99,reason:"A bounded contents check is needed."};
    assert.equal(conversationWorkProfile({...base,context:{...base.context,route:"inspect"}}).focused,false);
    for(const [i,text] of [base.user_text,"¿Qué disciplina contiene este modelo?","Can you identify the systems represented here?"].entries()) {
      const req={...base,message_id:String(i),user_text:text};
      await routeConversation(req,{interpret:async()=>({value:inspect})});
      const profile=conversationWorkProfile(req);assert.equal(profile.focused,true);assert.equal(profile.settings.reasoning_effort,"low");
      assert.match(profile.instruction,/exact observed scalar facts/);assert.match(profile.instruction,/verification requirements/);
      for(const extra of [{session_id:"foreign"},{message_id:"other"},{user_text:text+" Then delete the system."},{tool_results:[{}]},{user_attachments:[{}]}])
        assert.equal(conversationWorkProfile({...req,...extra}).focused,false);
      for(const settings of [{speed_mode:false,agent_reasoning_effort:"medium"},{speed_mode:true,agent_reasoning_effort:"high"}])
        assert.equal(conversationWorkProfile({...req,context:{ui:{speed_settings:settings}}}).focused,false);
    }
    const long={...base,message_id:"long",user_text:"Review all sheets, levels, disciplines and documentation gaps."};
    await routeConversation(long,{interpret:async()=>({value:{...inspect,route:"task"}})});
    assert.equal(conversationWorkProfile(long).settings.reasoning_effort,"medium");
    const uncertain={...base,message_id:"uncertain"};
    await routeConversation(uncertain,{interpret:async()=>({value:{...inspect,confidence:0.5}})});
    assert.equal(conversationWorkProfile(uncertain).focused,false);
  } finally {
    __closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
    assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});
  }
});
