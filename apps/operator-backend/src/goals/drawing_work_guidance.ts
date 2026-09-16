/** General workflow guidance, never fixture geometry or drawing answers. */
export function drawingWorkGuidance(source: string, broad: boolean): string {
  if (!broad || !/\b(drawing|pdf|record plan|redline)\b/i.test(source) || !/\b(duct|hvac|mep)\w*\b/i.test(source)) return "";
  return [
    "MULTI-AREA DRAWING WORK:",
    "Read an overview to establish coverage, then obtain closer attachment crops of dense equipment and junctions before interpreting their small symbols. Register source positions against observed architectural/model anchors; do not guess world coordinates from a page crop.",
    "Separate visible routes and labeled dimensions from unshown elevations, device sizes and airflows. Keep uncertainties in the work plan; proceed on independently clear branches. Nearby elements can inform types and unshown elevations, but copying a nearby system is not evidence that it matches this drawing.",
    "Useful native route contracts include /revit/mep-route-workflow for an explicit world-XYZ polyline with internally connected fittings, and /revit/create-family-instance for supported equipment. Read each exact tool schema once and reuse its retained documentation; do not spend repeated searches looking for equivalent tools when a documented path fits the work.",
    "Complete one useful branch batch, then verify all its created ducts and fittings together with /revit/get-parameters followed by /revit/get-connectors. Honor the explicit endpoint policy: open ends may be temporary construction stages, but completed systems still need final physical-connection inspection. Do not substitute the apply response's echoed coordinates for independent readback.",
    "Close the corresponding edit checklist item with verified operation IDs. Use kind=inspection with dependsOn for final connectivity checks, and obtain fresh native connector reads after the last edit. Continue the remaining declared scope; narration, a read-only inspection or one completed branch cannot establish completion of the whole drawing."
  ].join("\n");
}
