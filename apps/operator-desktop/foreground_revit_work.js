// Coordinate foreground HTTP runs with observational/background Revit work.
// Each run owns its lease until its asynchronous work settles, including errors.
export function createForegroundRevitWorkGate() {
  let activeRuns = 0;
  return {
    isBusy: () => activeRuns > 0,
    async run(work) {
      activeRuns += 1;
      try {
        return await work();
      } finally {
        activeRuns -= 1;
      }
    }
  };
}
