# Work laptop quick start

`OperatorDeploy.exe` is the per-user, portable Revit Operator installer and updater. It does not require Git, Node, Python, Visual Studio, Codex, or an installed .NET runtime.

1. Download the package for the Revit year installed on the workstation.
2. In Windows Explorer, open the ZIP properties and select **Unblock** when that option is present.
3. Extract the complete ZIP to a local folder. Do not run the updater from inside the ZIP viewer.
4. Save work and close every Revit window.
5. Run:

```powershell
.\OperatorDeploy.exe update --manifest .\manifest.json
```

6. Validate the installed release:

```powershell
.\OperatorDeploy.exe validate
```

7. Start Revit, then use `Operator Desktop.cmd` on the desktop when the external Sidecar is needed.

Useful recovery commands:

```powershell
.\OperatorDeploy.exe status
.\OperatorDeploy.exe repair --manifest .\manifest.json
.\OperatorDeploy.exe rollback
.\OperatorDeploy.exe diagnostics
```

The updater refuses to replace the active add-in pointer while Revit is running. It installs payloads side-by-side under `%LOCALAPPDATA%\RevitOperator\releases\`, preserves `%LOCALAPPDATA%\RevitOperator\config\` and `Workspace\`, and only activates a release after its manifest and every payload hash pass validation.

Internet self-update is deliberately disabled in this first version. A downloaded update must not be executed automatically until the release executable, payload, and update metadata have a verified signing chain.
