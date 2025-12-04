## Testnet Sentinel (datahaven-monitor)

[![Sanity – Hello World](https://github.com/<ftheirs>/<datahaven-monitor>/actions/workflows/sanity-cron.yml/badge.svg)](https://github.com/<ftheirs>/<datahaven-monitor>/actions/workflows/sanity-cron.yml)
[![Stress – Manual](https://github.com/<ftheirs>/<datahaven-monitor>/actions/workflows/manual-stress.yml/badge.svg)](https://github.com/<ftheirs>/<datahaven-monitor>/actions/workflows/manual-stress.yml)

Minimal sentinel project for running automated sanity checks and heavier manual
stress tests against the StorageHub Testnet. Early phases focus on a simple
hello-world sanity script to verify StorageHub SDK imports and CI wiring.

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

- **Run the sanity hello-world script**:

```bash
bun run sanity
```

### What exists right now

- Bun + TypeScript project scaffolded with Biome configuration.
- Sanity hello-world entrypoint under `src/sanity` that imports
  `storagehub-sdk/core` and `storagehub-sdk/msp-client` and prints basic
  information to the console.
- GitHub Actions workflow `sanity-cron.yml` scheduled every 15 minutes to
  build and run the sanity hello-world script, plus a reusable `notify.yml`
  template and a placeholder `manual-stress.yml` workflow.

Replace `<ftheirs>` and `<datahaven-monitor>` in the badge URLs above with your GitHub
namespace to make the status badges live.


