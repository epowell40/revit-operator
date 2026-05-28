# Public / Private Boundary

This repository contains the public Revit Operator core.

Public core includes:

- Revit add-in shell and local Revit bridge
- local/self-host backend
- generic Revit API tools
- goal-mode orchestration
- native view capture/export
- spatial/redline reasoning and verification tools
- MCP bridge
- public sample skills, prompts, docs, and tests

Private overlay remains in `revit-operator-private`:

- BIMTools hosted deployment and EC2/systemd/nginx runbooks
- operator.bimtools.com production wiring
- hosted admin consoles and production analytics
- customer, billing, license, and commercial account logic
- hosted JWT/auth integrations
- private skills and customer-specific plans
- `docs/epics/` and `Feature Request/` planning history

Code should branch on runtime configuration, not repository identity. Public-safe defaults are local/shared-token and self-hosted modes. Hosted/commercial features should be implemented as a private overlay unless they are redesigned as generic, non-customer-specific interfaces.
