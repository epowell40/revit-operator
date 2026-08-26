# Architecture

The durable raw-evidence and bounded model-context boundary is documented in
[EVIDENCE_PROJECTION.md](EVIDENCE_PROJECTION.md).

Settled Assignment review and customer-facing completion claims are defined by
the deterministic [Verified Work Packet](VERIFIED_WORK_PACKET.md).

Request-scoped shared-token and principal-JWT propagation for trusted
MCP-to-backend calls is defined by the
[authenticated internal backend transport](AUTHENTICATED_BACKEND_TRANSPORT.md).

Revit Operator is organized around a local Revit bridge, backend orchestration layer, skill runtime, and operator UI.

The public core should expose generic interfaces and local/self-host implementations. Hosted BIMTools implementations belong in the private overlay repo.

Code should branch on runtime mode/configuration, not repository identity.

Assignment execution, effect, retry, reconciliation, verification, and terminal
truth are defined by the [Assignment control plane](ASSIGNMENT_CONTROL_PLANE.md).
All execution substrates must use that contract rather than maintaining an
independent settlement interpretation.

The consolidation target for new versioned Assignments is the
[Assignment Kernel V2](ASSIGNMENT_KERNEL_V2.md). Its event journal is the only
mutable lifecycle truth; transports and customer/benchmark surfaces are edge
adapters or read-only projections. V2 remains default-off until the staged
migration and historical replay gates are complete.
