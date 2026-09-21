# Optional iShares relay

Use only when the deployment's outgoing IP cannot reach the provider.
Direct downloads remain the application default. This module is not part of
the Docker build or automatically deployed with the application.

1. Run `npx tsx deploy/ishares-relay/generate-allowlist.ts`.
2. Upload `worker.mjs` as a Cloudflare module Worker, with a current
   compatibility date, the `ALLOWED_URLS` JSON binding from `allowed-urls.json`
   and an `ALLOWED_IP` text binding containing the server's verified egress IP.
3. Enable its workers.dev endpoint. Set `ISHARES_RELAY_URL=https://<worker>.<account>.workers.dev/`
   in the application's server environment and redeploy.
4. Test API metadata, the latest dated payload, and CSV endpoints from the
   application container. Check holdings dates, row counts and identifiers.

All provider requests retain their original URLs for provenance. The relay
streams responses without storing holdings; SQLite retains the application's
normal 24-hour cache. Only exact catalog URLs and an optional eight-digit
`asOfDate` are permitted. Redirects are rejected. Incoming access is restricted
to the configured IP using Cloudflare's trusted connection header; update this
binding if the server's egress IP changes. Other callers receive 403.

When adding a source, regenerate and deploy the allowlist. BlackRock mutual-fund
CSV sources use the same optional transport. Other providers are unaffected.
To roll back, unset the application variable and redeploy; then disable/delete
the Worker if unused. Direct downloads will still fail if the IP remains blocked.

Cloudflare Free currently allows 100,000 incoming Worker requests per account
per day (reset at 00:00 UTC), 10 ms CPU per invocation, 128 MB memory and 50
external subrequests per invocation. This relay makes one external request per
invocation and streams the response; network waiting is not CPU time. A normal
BlackRock refresh usually needs two invocations per source (metadata and dated
holdings); retries, CSV fallbacks and forced refreshes add requests. Aliases and
derived funds reuse their source. No KV, R2, cron or paid subscription is needed.
Limits are shared with other Workers, and a free quota exhaustion causes errors.
Worker IPs can also be blocked by the provider: this is not a guaranteed bypass.

Verified 2026-09-21: [limits](https://developers.cloudflare.com/workers/platform/limits/)
and [pricing](https://developers.cloudflare.com/workers/platform/pricing/).
