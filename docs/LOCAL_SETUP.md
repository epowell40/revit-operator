# Install Open Core on Windows

Open Core runs on your own computer with your own OpenAI API key. It does not
require a BIMTools account or use the BIMTools hosted backend. OpenAI bills API
usage separately from any ChatGPT subscription.

## First setup

1. Install Autodesk Revit 2023–2027, a supported [Node.js LTS](https://nodejs.org/en/download)
   (22.23.4+ or 24.22.1+), and the [.NET SDK](https://dotnet.microsoft.com/download)
   (8 or later; 10 or later for Revit 2027). Install the SDK, not just the runtime.
2. Download [the public source ZIP](https://github.com/epowell40/revit-operator/archive/refs/heads/main.zip)
   and extract all files into a permanent, short path, for example `C:\RevitOperator`.
   Do not run setup inside the ZIP or a temporary folder.
3. Close Revit. Double-click **Setup-OpenCore.cmd**. Choose your Revit version if
   prompted. Setup installs locked Node dependencies, a project-local supported
   Codex runtime, and builds the add-in plus its self-contained C# execution runtime. The first build needs internet access
   and can take several minutes. Administrator rights are not required.
4. Notepad opens **OpenCore.settings.txt**. Replace `PASTE_YOUR_KEY_HERE` with your
   OpenAI API key, save, and close it. This private file has one setting:

   ```text
   OPENAI_API_KEY=PASTE_YOUR_KEY_HERE
   ```

5. Double-click **Start-OpenCore.cmd**. It starts the authenticated loopback-only
   backend and launches Revit with the matching local configuration. If Revit asks
   about the locally built RevitOperator add-in, review it and choose **Always Load**.
6. Open a disposable model, then choose **RevitOperator → Operator** on the ribbon. The current conversation interface opens inside Revit, with New Chat, Tasks, and Settings. Start with a read-only
   request such as “What model and view are open?” before trying model changes.

Keep the extracted folder: the add-in runs from its build output. Do not move or
delete it while installed. Your key is never passed as a command-line argument or
printed by these scripts. Do not share the settings file or `.opencore` folder;
the latter contains local task records and setup recovery information.

## Everyday use and recovery

- Start with **Start-OpenCore.cmd**, so Revit and the backend share the same local
  workspace and authentication. There is no BIMTools login in this mode.
- Save your work and close Revit, then run **Stop-OpenCore.cmd**. It stops this
  installation's interface and backend, not unrelated processes occupying either port.
- To return to a previous Operator package, close Revit, stop Open Core, and run
  **Restore-Previous-Install.cmd**. Setup retains the previous add-in registration
  and does not overwrite your hosted account configuration.
- Retry a failed build by running setup again. Registration changes happen only
  after the build succeeds. Setup stops rather than create duplicate registrations.
- If setup reports a missing prerequisite, install the named component and retry.
  For a particular version, run `Setup-OpenCore.cmd -RevitYear 2023`.
- For startup errors, review `.opencore/backend.error.log`. Do not post your API
  key or entire task history in a public issue.

## What is included

The ribbon opens the shared Operator interface **inside Revit**. To put the same
interface in a separate browser window, use **Open-Operator-Window.cmd** after
Start. Both views use the same local runtime and tasks; a second agent is not
started. The older native interface is no longer the standalone default.

Screen observation and interaction depend on the local runtime, current task
permissions, and Windows desktop availability, not which window hosts the UI.
The interface shows their availability. Stop remains available during work.
The Open Core runtime includes generic conversation, native API and computer
interaction code; the hosted account/sign-in implementation is not included.
Standalone connections use the local API key and loopback ports 7007 and 3907.
They do not discover or launch an unrelated installed BIMTools Desktop package.
There is no prebuilt GitHub release installer at this checkpoint. Source setup
needs the build prerequisites above; it is not a standalone binary installer.

For external coding agents without the Operator pane, see
[External agent harness](EXTERNAL_AGENT_HARNESS.md). For server deployment, see
[Self hosting](SELF_HOSTING.md).
