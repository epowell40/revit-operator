import {
  extractSheetVectorElementTopologyV1,
  type SheetVectorElementTopologyInputV1
} from "../existing_conditions/sheet_vector_element_topology.js";
import {
  extractSheetVectorTextV1,
  type SheetVectorTextExtractionInputV1
} from "../existing_conditions/sheet_vector_text.js";

type PathEntry = { flag: string; value: string };

export type ExistingConditionsSheetVectorCliDependencies = {
  requiredArgument: (name: string) => string;
  readJson: (filePath: string) => unknown;
  writeJson: (filePath: string, value: unknown) => void;
  assertFreshDistinctOutputPaths: (entries: PathEntry[], protectedEntries?: PathEntry[]) => void;
};

export async function handleExistingConditionsSheetVectorCommand(
  command: string,
  dependencies: ExistingConditionsSheetVectorCliDependencies
): Promise<boolean> {
  if (command !== "extract-sheet-vector-text" && command !== "extract-sheet-vector-topology") return false;
  const inputPath = dependencies.requiredArgument("--input");
  const outputPath = dependencies.requiredArgument("--out");
  dependencies.assertFreshDistinctOutputPaths(
    [{ flag: "--out", value: outputPath }],
    [{ flag: "--input", value: inputPath }]
  );
  const input = dependencies.readJson(inputPath);
  const receipt = command === "extract-sheet-vector-text"
    ? await extractSheetVectorTextV1(input as SheetVectorTextExtractionInputV1)
    : await extractSheetVectorElementTopologyV1(input as SheetVectorElementTopologyInputV1);
  dependencies.writeJson(outputPath, receipt);
  return true;
}
