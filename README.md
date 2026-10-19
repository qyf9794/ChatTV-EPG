# ChatTV Public EPG Publisher

The **standalone public-data publisher** for the ChatTV programme guide.

It reads a fixed allowlist of public XMLTV / channel metadata sources and publishes bounded, versioned static objects to Cloudflare R2. ChatTV clients consume the same edge URL as before this repository split. **No iOS/tvOS application, account sync, payment, Realtime, private EPG subscriptions, private user data, or Git history from the private application repository are included.**

## Scope / provenance

This is an explicitly allowlisted source snapshot from the private ChatTV application repository:
- `backend/packages/public-epg-publisher/` — existing publisher, including tests;
- `backend/packages/public-epg-contract/` — stable manifest/artifact contract;
- `backend/services/api/src/shared/public-epg-sources.ts` — only the **public** XMLTV source definitions.

The private ChatTV repository remains the authoritative source of shared contract changes and backend maintenance/upload integration. To refresh the public code, run `scripts/sync-from-private.sh /path/to/VocalTV_ios` on a trusted developer machine. The script copies **only these explicit paths**, reruns checks, and leaves all other private data out. Review the diff and tests before commit. Do not mirror the entire private repository or its commit history.

This repository intentionally contains **no R2 credentials**, private APIs, or production .env files.

## Local verification

Requirements: Node 24 and pnpm 9.12.2.

```sh
cd backend
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
```

Run `pnpm --filter @vocaltv/public-epg-publisher run dry-run-local` for a bounded local source fetch that does not publish to R2. The GitHub `Validate public EPG publisher` workflow uses only non-secret dependencies and can run on PRs.

## Publishing / rollout safety

- `Public EPG publication` runs at `17 */12 * * *` (UTC), twice daily, only when the **non-secret repository variable** `PUBLIC_EPG_PUBLISH_ENABLED=true` is set. Manual dispatch is also available for an authorized operator.
- The production writer requires these four GitHub Actions **repository secrets**: `EPG_PUBLISHER_R2_ACCOUNT_ID`, `EPG_PUBLISHER_R2_BUCKET`, `EPG_PUBLISHER_R2_ACCESS_KEY_ID`, `EPG_PUBLISHER_R2_SECRET_ACCESS_KEY`. Use a narrowly scoped R2 token; never commit a .env or echo credentials.
- The `Verify R2 publication access` workflow is strictly read-only. Verify it before initiating a first publish.
- **Only one repository may have scheduled publishing enabled at a time.** During cutover, verify this repo first, switch off the private repo variable, then enable this repository after a successful controlled publish. On failure, keep/restore the private publisher and disable this one.
- Publishing uses the original R2 bucket and `public-epg/v1/` immutable object keys, last-good pointer, bounded upload budgets and publication lease. It does not require an App release.
- Once the current pointer commits, the publisher emits a `publication` progress record with its revision. The final result reports `publicationOK: true` and a separate `retentionStatus` (`succeeded`, `skipped`, or `failed`). Cleanup failure keeps the committed pointer, reports a safe error code, public object key when available, and stage (`mark`, `list`, `delete`, or `checkpoint`), and still exits nonzero so Actions surfaces the failure. `retentionRan` means cleanup was attempted; only a complete sweep and successful checkpoint advance `lastRetentionAt`.
- Retention retries transient GET failures at most three times, with every attempt charged to the existing budgets and fenced by the current lease. Each R2 GET retains its 60-second deadline across headers and body consumption. A final read or validation failure stops queued reads and joins all in-flight branches before releasing the lease; graph or listing failure prevents deletion.
- PR builds receive **no secrets**. Do not merge untrusted workflow/code changes with write credentials in place. Protect the default branch and restrict maintainers.

This separation prevents the 12-hour publisher from consuming GitHub-hosted **private-repository** Actions minutes, using a standard runner in a public repository.
