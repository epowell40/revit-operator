/** Display metadata only. Authority and accepted values remain in the backend. */
export function assignmentInputMetadata(spec, variableId) {
  const prerequisite=spec?.interpreted_scope?.scope?.prerequisites?.find(item=>item.variable_id===variableId);
  return prerequisite?.kind === "approval"
    ? { input_kind:"approval",source_clause:prerequisite.source_quote }
    : { input_kind:"information" };
}

export function createAssignmentInputControl(document, question) {
  const approval=question.input_kind === "approval";
  const input=document.createElement(approval?"select":"textarea");
  input.required=true;
  input.setAttribute("aria-label",question.question);
  if(approval) {
    for(const [value,text] of [["","Choose an option"],["approve","I approve the requested action"],["decline","Do not proceed"]]) {
      const option=document.createElement("option");option.value=value;option.textContent=text;input.appendChild(option);
    }
    input.value=""; // Polls and a newly opened form must never preselect consent.
  } else {input.rows=2;input.maxLength=20000;}
  return { input,buttonText:approval?"Confirm choice":"Continue",sourceClause:approval?question.source_clause:undefined,
    value() {
      if(approval) {
        if(input.value==="decline")throw Error("assignment_approval_declined");
        if(input.value!=="approve")throw Error("assignment_approval_choice_required");
        return true;
      }
      if(!input.value.trim())throw Error("assignment_information_answer_required");
      return input.value;
    }
  };
}

/** Preserve the original machine error for diagnostics; only presentation changes. */
export function assignmentInputErrorText(error) {
  const code=String(error?.code??error?.message??"");
  if(code==="assignment_approval_declined")return "Approval was not given. The task remains paused.";
  if(["assignment_approval_choice_required","assignment_kernel_v2_approval_requires_explicit_true"].includes(code))
    return "This task requires an explicit approval choice. Choose Approve only if you consent to the action shown; otherwise choose Do not proceed.";
  if(["assignment_information_answer_required","assignment_kernel_v2_prerequisite_answer_required"].includes(code))return "Please answer the task question before continuing.";
  return error?.message||"Could not save the answer.";
}
