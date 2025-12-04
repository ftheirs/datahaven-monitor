## Testnet Sentinel (datahaven-monitor)

- [![Sanity – Full](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-cron.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-cron.yml)
- [![Sanity – Connection](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-connection.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-connection.yml)
- [![Sanity – Health](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-health.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-health.yml)
- [![Sanity – SIWE](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-siwe.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-siwe.yml)
- [![Sanity – Upload](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-upload.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-upload.yml)
- [![Sanity – Download](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-download.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-download.yml)
- [![Sanity – Delete](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-delete.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/sanity-delete.yml)
- [![Stress – Manual](https://github.com/ftheirs/datahaven-monitor/actions/workflows/manual-stress.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/manual-stress.yml)

Testnet Sentinel runs connection, health, auth, upload/download, and cleanup checks
against the StorageHub Testnet. Each CI workflow tracks a specific stage so you can
see green checks per part directly in GitHub.

### Quick start (local)

- **Install Bun** (see Bun documentation).
- **Install dependencies**:

```bash
bun install
```

- **Build TypeScript**:

```bash
bun run build
```

- **Run the full sentinel suite**:

```bash
bun run sanity:full
```

- **Run a specific stage**:

```bash
bun run sanity:connection    # connectivity only
bun run sanity:health        # backend health
bun run sanity:siwe          # SIWE auth
bun run sanity:upload        # bucket + uploads
bun run sanity:download      # upload + download
bun run sanity:delete        # upload + delete flows
```

### What exists right now

- Bun + TypeScript project scaffolded with Biome configuration.
- Sanity entrypoint under `src/sanity` that exercises StorageHub SDK calls across
  connection, health, SIWE, upload/download, deletion, and SDK smoke checks.
- GitHub Actions workflow `sanity-cron.yml` scheduled every 15 minutes to
  build and run the full sentinel suite (currently set to hourly; the 15-minute
  cron is kept commented for future use), plus per-stage workflows with matching
  badges, a reusable `notify.yml` template, and a placeholder `manual-stress.yml`
  workflow.
