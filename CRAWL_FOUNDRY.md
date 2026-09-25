# Crawl Foundry Postiz fork

This public AGPL-3.0 fork tracks upstream `gitroomhq/postiz-app` from tag
`v2.24.0`. The `crawl-foundry` branch carries four source-level changes:

1. Content Studio's conditional public API write and expanded post read model
   (`studioBridgeVersion: 1`). The original JavaScript image patch is retired.
2. DEV organization discovery and LinkedIn personal-profile OAuth support.
3. The `crawlfoundry-blog` provider, which releases an existing Directus
   translation by ID. It never writes article text. Postiz keeps a title
   snapshot for the calendar and a public URL after Directus publishes it.
4. The branded channel icon and editor selector.

## Update from upstream

Fetch upstream, review its release notes and schema changes, then merge the
selected upstream tag into `crawl-foundry`. Resolve provider/DTO/editor
conflicts in TypeScript; never revive compiled-JavaScript volume overrides.
Run the bridge tests, backend/frontend builds, and a test-draft publication
against the new image before moving scheduled articles. Review schema changes
before `prisma db push` and never use `--accept-data-loss` automatically.

## Build and roll out

Build from this branch with the upstream `Dockerfile.dev` and Node 22 runtime.
The image must retain `/app`, PM2, nginx, and the existing entrypoint layout.
Before changing Compose, back up the Postiz database and every Compose file.
Keep the existing five Compose files in their current order and replace only
the final image override. Remove the old bridge image override and the DEV and
LinkedIn compiled-JavaScript volume mounts after the fork image has passed
its smoke checks. Configure `CRAWL_FOUNDRY_DIRECTUS_URL` to the exact internal
Directus URL and attach Postiz to the Directus Docker network. Store the
Directus token only in Postiz's encrypted integration fields or server secrets.

After restart, verify the existing queued-post count and IDs, connected
channels, `studioBridgeVersion: 1`, MCP tools, orchestrator logs, and one
isolated noindex test-draft publication. Keep Directus scheduling as the
fallback until the website's CMS-driven blog release change is deployed.

Rollback: restore the backed-up Compose files and start the previous image
`crawl-foundry-postiz:studio-bridge-v1-2.24.0` with `up -d --no-deps postiz`.
