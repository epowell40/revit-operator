export const retainedResultQuestions = [
  "Which duct types were in that sample? Give me their names and counts in a small table, using the result you already collected.",
  "Show the prior report's sheet names and counts in a table.",
  "What did the earlier results say about the equipment schedule?",
  "Compare the previous findings with the earlier report and explain the differences.",
  "Summarize the retained sample of Revit equipment. Do not change the model."
];
export const retainedResultMixedRequests = [
  ...["Inspect the selected duct too.", "Verify those counts in the current model.", "Rename sheet M102 to Review.",
    "Refresh the equipment schedule.", "Run the program again.", "Continue the task.", "Email the architect.",
    "Show those ducts in Revit.", "Compare them with our model.", "Export a PDF.", "Make model changes.", "Do what the report recommends."].map(suffix => retainedResultQuestions[0] + " " + suffix),
  "Using the previous report, set those duct sizes to 18 inches.",
  "Check the previous report against the live model.",
  "What are the current values compared to the prior report?"
];
