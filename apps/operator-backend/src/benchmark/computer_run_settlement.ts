export type ComputerRunState = Record<string, unknown> & { running?: unknown };

export type ComputerRunSettlement<TState extends ComputerRunState> = {
  state: TState;
  stop_requested: boolean;
  became_idle: boolean;
  poll_count: number;
  stop_error: string | null;
  state_errors: string[];
};

export async function settleTimedOutComputerRun<TState extends ComputerRunState>(input: {
  initialState: TState;
  stopRun: () => Promise<void>;
  readState: () => Promise<TState>;
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}): Promise<ComputerRunSettlement<TState>> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const settleTimeoutMs = Math.max(1, input.settleTimeoutMs ?? 30_000);
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? 250);
  let state = input.initialState;
  if (state.running === false) {
    return { state, stop_requested: false, became_idle: true, poll_count: 0, stop_error: null, state_errors: [] };
  }

  let stopError: string | null = null;
  try {
    await input.stopRun();
  } catch (error) {
    stopError = error instanceof Error ? error.message : String(error);
  }

  const deadline = now() + settleTimeoutMs;
  const stateErrors: string[] = [];
  let pollCount = 0;
  while (state.running !== false && now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    pollCount += 1;
    try {
      state = await input.readState();
    } catch (error) {
      stateErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    state,
    stop_requested: true,
    became_idle: state.running === false,
    poll_count: pollCount,
    stop_error: stopError,
    state_errors: stateErrors
  };
}
