import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

type RetentionStatus = "succeeded" | "skipped" | "failed";

function cliFixtureHook(entrypoint: "run.ts" | "run-local.ts", status: RetentionStatus): {
  hook: string;
  summary: Record<string, unknown>;
} {
  const local = entrypoint === "run-local.ts";
  const summary = {
    revision: "a".repeat(64),
    published: status !== "skipped",
    retentionRan: status !== "skipped",
    retentionStatus: status,
    retentionError: status === "failed" ? "r2_get_failed:0:TimeoutError" : null,
    retentionErrorKey: status === "failed" ? "public-epg/v1/objects/" + "b".repeat(64) + ".json.gz" : null,
    retentionFailureStage: status === "failed" ? "mark" : null
  };
  const publisher = `
    const summary = ${JSON.stringify(summary)};
    export const PUBLISHER_RUN_LIMITS = { maxR2GetRequests: 100, maxR2PutRequests: 100 };
    export async function runPublisher({ store, onProgress, budgets }) {
      if (store.fixtureKind !== ${JSON.stringify(local ? "local" : "r2")}) throw new Error("cli_fixture_store_missing");
      if (${local} && (budgets.maxR2GetRequests !== 100 || budgets.maxR2PutRequests !== 100)) {
        throw new Error("cli_fixture_budget_invalid");
      }
      onProgress({ phase: "publication", revision: summary.revision, published: summary.published });
      onProgress({ phase: "retention", ...summary });
      return summary;
    }
    export const backfillProgrammeNameCompanion = runPublisher;
  `;
  const remoteStore = `
    export function r2StoreFromEnvironment() {
      return { fixtureKind: "r2", close() { globalThis.cliFixtureStoreClosed = true; } };
    }
  `;
  const localStore = `
    export class LocalObjectStore {
      fixtureKind = "local";
      constructor(root) {
        if (!root) throw new Error("cli_fixture_root_missing");
      }
    }
  `;
  const dataURL = (source: string) => "data:text/javascript," + encodeURIComponent(source);
  const modules = {
    "./publish.js": dataURL(publisher),
    "./s3-store.js": dataURL(remoteStore),
    "./local-store.js": dataURL(localStore)
  };
  const entryURL = new URL("../src/" + entrypoint, import.meta.url).href;
  const hook = `
    import { registerHooks } from "node:module";
    const modules = ${JSON.stringify(modules)};
    globalThis.fetch = async () => { throw new Error("cli_fixture_network_forbidden"); };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL === ${JSON.stringify(entryURL)} && modules[specifier]) {
          return { url: modules[specifier], shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
    });
    if (!${local}) process.once("exit", () => {
      if (!globalThis.cliFixtureStoreClosed) {
        process.stderr.write("cli_fixture_store_not_closed" + String.fromCharCode(10));
        process.exitCode = 2;
      }
    });
  `;
  return { hook, summary };
}

for (const entrypoint of ["run.ts", "run-local.ts"] as const) {
  for (const status of ["succeeded", "skipped", "failed"] as const) {
    test(`${entrypoint} reports ${status} retention through its real CLI and exit code`, { timeout: 20_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "public-epg-cli-test-"));
      try {
        const { hook, summary } = cliFixtureHook(entrypoint, status);
        const hookPath = join(root, "fixture-hook.mjs");
        await writeFile(hookPath, hook);
        const env: NodeJS.ProcessEnv = { ...process.env, EPG_PUBLISHER_LOCAL_STORE: join(root, "objects") };
        delete env.EPG_PUBLISHER_LOCAL_MAX_R2_GETS;
        delete env.EPG_PUBLISHER_LOCAL_MAX_R2_PUTS;
        const child = spawnSync(process.execPath, ["--import", "tsx", "--import", hookPath,
          fileURLToPath(new URL("../src/" + entrypoint, import.meta.url))], {
          cwd: packageRoot,
          env,
          encoding: "utf8",
          timeout: 15_000
        });
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.signal, null, child.stderr);
        assert.equal(child.status, status === "failed" ? 1 : 0, child.stderr);
        const stdout = child.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const results = stdout.filter((line) => line.progress !== true);
        assert.equal(results.length, 1, child.stdout);
        const local = entrypoint === "run-local.ts";
        assert.deepEqual(results[0], {
          ok: status !== "failed",
          publicationOK: true,
          ...(local ? { storeMode: "local", temporaryStore: false } : {}),
          ...summary
        });
        const progress = (local ? child.stderr.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
          : stdout).filter((line) => line.progress === true);
        assert.equal(progress.length, 2, "the real entrypoint must forward publisher progress");
        assert.equal(progress[0]?.phase, "publication");
        assert.equal(progress[1]?.phase, "retention");
        assert.equal(progress[1]?.retentionStatus, status);
        if (!local) assert.equal(child.stderr, "", "the R2 fixture must close without an error");
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
