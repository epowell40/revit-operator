// Source-only bootstrap for the existing `tsx watch` development command.
// Compiled production builds use task_navigation_worker.js directly.
import { tsImport } from "tsx/esm/api";
await tsImport("./task_navigation_worker.ts", import.meta.url);
