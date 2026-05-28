# Fire Alarm Layout (MVP)

This folder contains example config files for the `revit_fire_alarm_layout` MCP tool.

## Quick start

1. Ensure your model has a suitable placeholder family loaded (or update mappings to your actual FA device families/types).
2. Call the tool with a full path to `run_config.example.json`:

```json
{
  "runConfigPath": "C:/Users/User/source/repos/RevitOperator/mcp-server/data/firealarm/run_config.example.json",
  "levelName": "Level 1",
  "createVisualizer": true
}
```

## Visualizer controls

Hide markers:

```json
{ "viewId": 12345, "action": "hide" }
```

Clear markers:

```json
{ "viewId": 12345, "action": "clear" }
```

