# Website deployment

This branch runs one Next.js standalone process and one durable SQLite database.
Caddy routes `pf.nejilu.com` and `admin-pf.nejilu.com` to that process.
Cloudflare Access protects the entire owner hostname. No tunnel is required.

## Access

- Public hostname: Holdings, comparisons, Metrics, and published portfolio details.
- Owner hostname: all tabs and writes, after Access authenticates the configured owner.
- The application verifies the Access JWT signature (RS256), issuer, audience,
  expiration and owner email. A plain email header or a forwarded host is not trusted.
- Public-host requests never acquire owner permissions, even with an Access token.
- Owner writes require an exact matching `Origin`. Cross-origin writes are denied.
- Missing configuration, unknown hosts and invalid tokens fail closed.
- `SITE_ACCESS_MODE=local` enables full access only for loopback development and
  is rejected in production. Start development with `npm run dev -- --hostname 127.0.0.1`.

For both local views, set `SITE_ACCESS_MODE=local` and
`SITE_LOCAL_PUBLIC_PREVIEW=true` in `.env.development.local`. With the default
port, `http://localhost:3000` is the full owner interface and
`http://127.0.0.1:3000` is the public interface. Both use the same process and
database. Owner sign in/Public website links switch between them without a
Cloudflare login in development. This preview option cannot enable local mode
in production.

## Visibility

Set Website visibility when saving a portfolio ETF or custom ETF. Use Apply
visibility to change an existing ETF without fetching prices or changing its positions.
The owner can also open Website publication from Holdings or Metrics to change
visibility without first loading the portfolio editor.

| Mode | Public access |
| --- | --- |
| Private | Hidden from the catalog and inaccessible by ID or ticker |
| Weights only | Composition, weights and analytics; no personal quantities or cash amounts |
| Public | Composition and analytics, plus exact saved portfolio positions, cash and current valuation |

The working portfolio and all editing definitions remain owner-only. Public
amounts appear under Holdings in a read-only Published positions panel. Custom
ETFs have no personal account amounts; their public modes both expose composition.
Public analysis responses omit internal portfolio links and generated descriptions.
Names are public for published ETFs. Market prices are not personal position amounts.

Migration 0014 makes existing saved portfolios private, existing custom ETFs
weights-only, and source funds public. New portfolios default to private; new
custom ETFs default to weights-only. Original quantities remain unchanged in SQLite.
An ETF depending directly or indirectly on a private, missing or cyclic source
is also hidden. Changing a source back to public restores eligible descendants.

Visibility cannot revoke data someone already downloaded while an ETF was public.

## VPS setup

### Automatic deployment on the current VPS

Dokploy's `Webapp` service follows `codex/site-deployment-access` using
`deploy/dokploy-compose.yaml`. A GitHub push webhook triggers a fresh checkout,
Docker build, and replacement of the application container. Other branches are
ignored. There is no CI test gate or server-side test suite; the Dockerfile runs
the production build only. Dokploy waits for the container health check.

Runtime secrets stay in Dokploy. SQLite stays in
`/home/julie/weightings-analytics/data`; it is not part of the image.
Traefik routes the public and owner hostnames to the same application.

The deployment image is `weightings-analytics:production`. No archive image or
custom image-retention timer is maintained. Unused Docker images and build cache
are not automatically removed by this setup.

The following Caddy/systemd instructions describe alternative installations,
not the current Dokploy/Traefik VPS.

1. Create a dedicated `weightings` system account. Install Node.js matching
   `package.json` and build this branch in `/opt/weightings-analytics`:
   `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.
2. Before installing this revision over an existing database, run
   `npm run db:backup` from the previous installed revision. The backup command
   applies pending migrations, so running it from the new revision would migrate
   first. Keep backups outside the served directory.
3. Create `/var/lib/weightings-analytics`, owned by `weightings`. Create
   `/etc/weightings-analytics.env` from `.env.example`, using the actual domains,
   Access team domain, application audience and owner email. Set
   `DATABASE_PATH=/var/lib/weightings-analytics/weightings-analytics.sqlite` and
   `DRIZZLE_MIGRATIONS_PATH=/opt/weightings-analytics/drizzle`. Restrict this file
   to the service administrator. Leave `SITE_ACCESS_MODE=cloudflare`.
4. The service account needs read access to the checkout, write access to the
   database directory, and write access to `.next/standalone` for startup asset
   preparation. Copy `deploy/weightings-analytics.service` to systemd, adjusting
   the npm path if necessary. Run `systemctl daemon-reload` and
   `systemctl enable --now weightings-analytics`.
5. Point both DNS records at the VPS with Cloudflare proxying enabled (orange
   cloud). Add `deploy/Caddyfile.example` to the existing Caddy configuration;
   both domains proxy to `http://127.0.0.1:3000`. The example assumes Caddy and
   Node run directly on the same host, not in separate containers. Validate and
   reload Caddy. Use valid origin certificates and Cloudflare Full (strict) TLS.
   Preserve `Host`, `Origin` and `Cf-Access-Jwt-Assertion`, as Caddy's default
   HTTP reverse proxy does. Do not expose port 3000 on the VPS firewall.
6. Create an Access self-hosted application covering **all paths** of the owner
   hostname. Use Connect with Cloudflare and allow only the owner's identity;
   do not add bypass or everyone policies. Keep the public hostname outside Access.
7. Keep the default cache behavior: ordinary Caddy `reverse_proxy` does not cache
   responses, and the app sends no-store directives for pages and API responses.
   Do not override them with Cache Everything or a forced edge TTL. Static Next
   assets may be cached. Consider an edge API rate limit for expected traffic.
8. Check the real HTTPS URLs: anonymous catalog access succeeds; anonymous owner
   writes return 403; the owner hostname requests login; authenticated edits work;
   a newly published ETF appears publicly. Test all three visibility modes and
   confirm that the origin port cannot be reached from the Internet.

`/api/health` remains an unauthenticated readiness endpoint containing no portfolio
data. Cloudflare configuration and external-origin reachability require live VPS
validation; local tests cannot establish those facts.

### Access configuration values

`/etc/weightings-analytics.env` is created on the Linux VPS; it is not a tracked
repository file. Set `SITE_PUBLIC_ORIGIN=https://pf.nejilu.com` and
`SITE_OWNER_ORIGIN=https://admin-pf.nejilu.com`.

- `CF_ACCESS_TEAM_DOMAIN`: the Zero Trust organization URL, including `https://`
  and ending in `.cloudflareaccess.com`.
- `CF_ACCESS_AUD`: the Application Audience (AUD) Tag under Access controls >
  Applications > the admin application > Configure > Additional settings. This
  identifies which Access application the signed login token is intended for.
- `SITE_OWNER_EMAIL`: the email of the authenticated Cloudflare account. This
  identifies the owner; it does not enable email PIN login or a second login.

Restrict direct origin access to Cloudflare if relying on its per-IP limits or
edge rules. The application independently validates owner tokens even on direct
requests; a client-supplied email header cannot grant owner access.

## Freshness and capacity

API responses use `private, no-store`; pages render at request time. Source data
caches remain shared. Successful owner writes advance a process-wide revision,
invalidating Metrics result keys and holdings in-flight reuse. Public requests
that overlap a mutation return 409 rather than publishing an old representation.
Open tabs reload the catalog on focus and every 30 seconds while visible; changed
revisions clear obsolete analysis results. Exact public positions refresh every
30 seconds. The revision also changes after a process restart.

The application admits up to 120 public API reads per IP per minute and 600
globally. Forced refresh is admitted once per route/selection per minute, up to
12 globally; subsequent requests use normal shared caches. These limits are
single-process and reset on restart. Per-IP limits use Cloudflare's client IP
header, which is trusted only when direct origin requests are excluded. The
global cap applies independently of that header. Tune edge limits before
increasing application capacity. Provider failures remain possible.

Use `npm run test:site` for access, projection, visibility and invalidation tests.
For an isolated browser preview, `node --import tsx scripts/site-preview-fixture.ts`
creates a new temporary SQLite database and prints its path. Set `DATABASE_PATH`
to that path for the preview process; all fixture securities and amounts are synthetic.
Run the full tests, typecheck, targeted lint, production build and
`npm audit --omit=dev` before deployment. Keep the application single-instance.

## References

- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## Provider connectivity

Test iShares/BlackRock downloads from the application container: datacenter IPs
may receive HTTP 403 despite a working website. Reverse-proxying incoming
traffic through Cloudflare does not alter outgoing requests. An optional
operator-managed relay is documented in [the relay guide](../deploy/ishares-relay/README.md).
Leave `ISHARES_RELAY_URL` unset for direct access. Configure it only in the server
environment when needed; it is not a mandatory project dependency.

Holdings refresh failures show an alert with the provider/transport error code
and the retained composition date. The same diagnostics propagate through
shared holdings, derived funds, portfolios, comparisons and metrics.
`/api/health` reports application/database readiness, not provider connectivity.
