import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalObjectStore } from "./local-store.js";
import { PUBLISHER_RUN_LIMITS, runPublisher, type PublisherProgress } from "./publish.js";

function safeError(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:-]{1,80}$/iu.test(error.message)
    ? error.message
    : "publisher_failed";
}

const configuredPath = process.env.EPG_PUBLISHER_LOCAL_STORE;
const temporaryStore = !configuredPath;
const root = configuredPath ? resolve(configuredPath) : await mkdtemp(join(tmpdir(), "vocaltv-public-epg-"));
const store = new LocalObjectStore(root);
const configuredReadBudget = process.env.EPG_PUBLISHER_LOCAL_MAX_R2_GETS;
const localReadBudget = configuredReadBudget === undefined ? PUBLISHER_RUN_LIMITS.maxR2GetRequests : Number(configuredReadBudget);
const configuredWriteBudget = process.env.EPG_PUBLISHER_LOCAL_MAX_R2_PUTS;
const localWriteBudget = configuredWriteBudget === undefined ? PUBLISHER_RUN_LIMITS.maxR2PutRequests : Number(configuredWriteBudget);
const onProgress = (progress: PublisherProgress): void => {
  process.stderr.write(JSON.stringify({ progress: true, ...progress }) + "\n");
};
try {
  if (!Number.isSafeInteger(localReadBudget) || localReadBudget < 1 || localReadBudget > PUBLISHER_RUN_LIMITS.maxR2GetRequests
    || !Number.isSafeInteger(localWriteBudget) || localWriteBudget < 1 || localWriteBudget > PUBLISHER_RUN_LIMITS.maxR2PutRequests) {
    throw new Error("local_operation_budget_invalid");
  }
  const result = await runPublisher({
    store,
    budgets: { maxR2GetRequests: localReadBudget, maxR2PutRequests: localWriteBudget },
    onProgress
  });
  const cleanupFailed = result.retentionStatus === "failed";
  process.stdout.write(JSON.stringify({ ok: !cleanupFailed, publicationOK: true, storeMode: "local", temporaryStore, ...result }) + "\n");
  if (cleanupFailed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, storeMode: "local", error: safeError(error) }) + "\n");
  process.exitCode = 1;
} finally {
  if (temporaryStore) await rm(root, { recursive: true, force: true });
}
