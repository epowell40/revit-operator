# Operator Environment Profile Manual Test Checklist

## Environment Profile

- Delete `%LOCALAPPDATA%\RevitOperator\environment_profile.json`.
- Launch Operator.
- Confirm the profile is recreated.
- Confirm preferred folders are recorded:
  - `%USERPROFILE%\Documents\RevitOperator`
  - `%USERPROFILE%\Documents\RevitOperator\Exports`
  - `%LOCALAPPDATA%\RevitOperator\Logs`
  - `%LOCALAPPDATA%\RevitOperator\Temp`
- Confirm capabilities and tool status are recorded.

## Known-Good Path Policy

- Ask Operator to export or create a small file.
- Confirm the action uses the preferred export directory when no explicit output folder is requested.
- Confirm it does not write to `C:\Program Files`, `C:\Windows`, root `C:\`, or a Revit install directory.

## Failure Memory

- Force a permission-denied output path.
- Confirm the failed operation is recorded in `known_failed_operations`.
- Confirm Operator retries or recommends the preferred export/temp directory.
- Start a new chat/session.
- Confirm the same blocked path is not retried blindly.

## Corporate Restrictions

- On a machine where PowerShell is blocked, refresh the environment profile.
- Confirm `tools.powershell.available=false`.
- Confirm the agent summary says PowerShell is restricted.
- Confirm the agent does not keep trying PowerShell for normal work.

## Demo Readiness

- Open the Environment/System Readiness area.
- Click Demo Check.
- Confirm it reports ready/limited accurately for:
  - Revit API
  - active document
  - backend
  - screen capture
  - export folder
  - action log
  - PDF export
  - computer use

## Session Injection

- Start a new typed chat.
- Confirm the prompt context includes the Local Operator Environment Summary.
- Start a voice dictation or computer-use turn if enabled.
- Confirm it receives the same preferred paths and restrictions.

## Regression

- Existing chat still works.
- Existing Revit tools still work.
- Existing logs still write.
- App still launches if the profile is missing or corrupt.

