import { PUBLIC_EPG_CURRENT_KEY, validCurrentPointer } from "../packages/public-epg-contract/src/index.js";
import { r2StoreFromEnvironment } from "../packages/public-epg-publisher/src/s3-store.js";

// Read-only smoke test: never writes or publishes, and never logs credentials.
const store = r2StoreFromEnvironment();
try {
  const pointerBytes = await store.get(PUBLIC_EPG_CURRENT_KEY, 2048);
  if (!pointerBytes) throw new Error("public_epg_pointer_missing");
  const pointer: unknown = JSON.parse(new TextDecoder().decode(pointerBytes));
  if (!validCurrentPointer(pointer)) throw new Error("public_epg_pointer_invalid");
  const manifest = await store.get(pointer.manifestKey, 2 * 1024 * 1024);
  if (!manifest) throw new Error("public_epg_manifest_missing");
  console.log("R2 read-only smoke verified: pointer and manifest accessible");
} catch (error) {
  console.error(error instanceof Error ? error.message : "r2_smoke_failed");
  process.exitCode = 1;
} finally {
  store.close();
}
