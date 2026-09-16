export const standaloneEngineeringQuestion = "For a preliminary HVAC check, calculate the round duct diameter needed to carry 1,200 CFM at no more than 800 feet per minute. Show the equations and units, and check a public manufacturer or engineering reference on the web for the method. Cite the reference you actually checked. Explain what else must be evaluated before using the size in a design. This is a standalone calculation and research question; do not inspect or change the Revit model.";

export const independentEngineeringQuestions = [standaloneEngineeringQuestion,
  "For a round supply duct carrying 1,200 cfm, calculate the minimum inside diameter to stay at or below 800 fpm. Show units and compare practical 16, 17 and 18 inch sizes. Find and cite a manufacturer or engineering reference for the airflow-area relationship. Explain what this calculation does and does not establish. Do not change anything in Revit.",
  "Calculate the heat transfer from the provided assumptions. Don't modify any parameters in the model.",
  "Research the manufacturer's fan curve. Never inspect or edit anything within Revit.",
  "Explain static pressure. Do not use Revit."
] as const;
