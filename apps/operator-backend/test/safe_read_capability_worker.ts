import { SafeReadCapabilityService } from "../src/capabilities/safe_read_capability.js";

type WorkerInput = {
  databasePath: string;
  manifestPath: string;
  pin: string;
  scope: string;
  request: unknown;
  now: string;
};

const input = JSON.parse(Buffer.from(process.argv[2]!, "base64url").toString("utf8")) as WorkerInput;
const service = new SafeReadCapabilityService({
  databasePath: input.databasePath,
  manifestPath: input.manifestPath,
  env: { OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256: input.pin },
  now: () => new Date(input.now)
});

process.send?.({ ready: true });
process.once("message", () => {
  try {
    const receipt = service.authorizeExecution(input.scope, input.request);
    process.send?.({ ok: true, receipt });
  } catch (error) {
    process.send?.({
      ok: false,
      code: typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN"
    });
  } finally {
    service.close();
    process.disconnect?.();
  }
});
