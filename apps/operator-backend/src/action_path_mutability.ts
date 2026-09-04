// All TypeScript producers and consumers share one route-effect contract.
// Keep this compatibility module so existing backend imports do not create a
// second path table.
export {
  canonicalRevitActionPath,
  conditionalActionPathEffect,
  pathLooksWrite,
  revitRouteEffect,
  revitRouteCertificationEffect,
  revitRouteEffectWhenBodyUnavailable
} from "@revitoperator/revit-action-effect-v1";

export type {
  RevitActionEffect as ConditionalActionPathEffect
} from "@revitoperator/revit-action-effect-v1";
