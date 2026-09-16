export const navigationPreservationRequests = [
  "Show the revised sheet M102 in Revit so I can review its title block. Do not make any further model changes.",
  "Show the previous model change on sheet M102. Do not make any further model changes.",
  "Inspect the sheet and explain how to rename it. Do not make any additional model changes.",
  "Open sheet M102 in Revit. Do not make further changes to the model.",
  "Inspect the current sheet. Don't perform any additional model modifications.",
  "Show the current view. Never apply additional changes to the document."
] as const;

export const scopedFurtherChangeRequests = [
  "Rename sheet M102 to Team Review. Do not make any further model changes.",
  "Set the selected duct Comments to Reviewed. Do not apply additional changes to the model."
] as const;
