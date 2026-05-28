import { scanAndProcessUploadQueue } from "../improvement/upload_queue_processor.js";
import { resolveImprovementUploadSettings } from "../improvement/upload_settings.js";

async function main(): Promise<void> {
  const settings = resolveImprovementUploadSettings();

  const results = await scanAndProcessUploadQueue({
    upload_url: settings.upload_url,
    upload_token: settings.upload_token,
    gzip: settings.gzip,
    max_per_tick: Math.max(1, Math.min(25, settings.max_per_tick || 10)),
    max_lines_per_file: settings.max_lines_per_file,
    timeout_ms: settings.timeout_ms,
    retry_backoff_ms: 0
  });

  const okCount = results.filter(r => r.ok && (r as any).uploaded).length;
  const failCount = results.filter(r => !r.ok).length;

  // eslint-disable-next-line no-console
  console.log(`[upload-queue] processed=${results.length} ok=${okCount} failed=${failCount}`);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r));
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(`[upload-queue] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
