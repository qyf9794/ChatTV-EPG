import { r2StoreFromEnvironment } from "./s3-store.js";
import { backfillProgrammeNameCompanion, runPublisher, type PublisherProgress } from "./publish.js";

function safeError(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:-]{1,80}$/iu.test(error.message)
    ? error.message
    : "publisher_failed";
}

const store = r2StoreFromEnvironment();
const onProgress = (progress: PublisherProgress): void => {
  process.stdout.write(JSON.stringify({ progress: true, ...progress }) + "\n");
};
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== "--backfill-source-names") {
    throw new Error("publisher_arguments_invalid");
  }
  const result = await (args[0] === "--backfill-source-names"
    ? backfillProgrammeNameCompanion({ store, onProgress })
    : runPublisher({ store, onProgress }));
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: safeError(error) }) + "\n");
  process.exitCode = 1;
} finally {
  store.close();
}
