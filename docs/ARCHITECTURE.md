# Architecture

Revit Operator is organized around a local Revit bridge, backend orchestration layer, skill runtime, and operator UI.

The public core should expose generic interfaces and local/self-host implementations. Hosted BIMTools implementations belong in the private overlay repo.

Code should branch on runtime mode/configuration, not repository identity.

Assignment execution, effect, retry, reconciliation, verification, and terminal
truth are defined by the [Assignment control plane](ASSIGNMENT_CONTROL_PLANE.md).
All execution substrates must use that contract rather than maintaining an
independent settlement interpretation.
