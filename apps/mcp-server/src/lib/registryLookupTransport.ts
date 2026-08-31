export type RegistryLookupOperationRoleV2 = "prerequisite" | undefined;

export type RegistryLookupTransportContractV2 = Readonly<{
  channel: "search";
  alias?: "revit_tool_registry";
}>;

export function registryLookupTransportContractV2(role: RegistryLookupOperationRoleV2): RegistryLookupTransportContractV2 {
  return role === "prerequisite"
    ? { channel: "search", alias: "revit_tool_registry" }
    : { channel: "search" };
}
