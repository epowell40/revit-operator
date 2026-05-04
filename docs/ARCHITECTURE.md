# Architecture

Revit Operator is organized around a local Revit bridge, backend orchestration layer, skill runtime, and operator UI.

The public core should expose generic interfaces and local/self-host implementations. Hosted BIMTools implementations belong in the private overlay repo.

Code should branch on runtime mode/configuration, not repository identity.
