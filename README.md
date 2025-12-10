## Testnet Sentinel (datahaven-monitor)

- [![Sanity – Connection](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/connection.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Health](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/health.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – SIWE](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/auth.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Create Bucket](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/bucket-create.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Issue Storage Request](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/storage-request.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Upload File](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/file-upload.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Download File](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/file-download.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Delete File](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/file-delete.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Delete Bucket](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/bucket-delete.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Stress – Manual](https://github.com/ftheirs/datahaven-monitor/actions/workflows/manual-stress.yml/badge.svg?branch=main)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/manual-stress.yml)

Testnet Sentinel runs comprehensive end-to-end monitoring of StorageHub functionality,
testing the full lifecycle: connection, authentication, bucket management, file storage,
and cleanup. Each stage is monitored and badged independently.

### Quick start (local)

- **Install Bun** (see Bun documentation).
- **Install dependencies**:

```bash
bun install
```

- **Run the monitor** (requires MSP-capable private key):

```bash
ACCOUNT_PRIVATE_KEY=0x... DATAHAVEN_NETWORK=stagenet bun run monitor
```

Available networks: `stagenet` (default), `testnet`

### Architecture

The monitor is structured as a sequential test suite with 9 stages:

1. **Connection**: Verify SDK clients can connect to chain and MSP backend
2. **Health**: Check MSP backend health status
3. **Auth**: Authenticate via SIWE (Sign-In with Ethereum)
4. **Bucket Create**: Create bucket on-chain and wait for indexing
5. **Storage Request**: Issue storage request with proper chain finalization waits
6. **File Upload**: Upload file after MSP readiness confirmation
7. **File Download**: Download and verify file integrity
8. **File Delete**: Request deletion and verify cleanup
9. **Bucket Delete**: Delete bucket and verify removal

Each stage runs independently and reports its status (passed/failed/skipped) to generate
dynamic badges. The monitor uses proper wait mechanisms for chain finalization and backend
indexing to handle public network constraints.

### Technology

- **Runtime**: Bun + TypeScript
- **SDKs**: `@storagehub-sdk/core`, `@storagehub-sdk/msp-client`
- **Chain interaction**: Polkadot.js API + Viem
- **CI/CD**: GitHub Actions with hourly cron (configurable to 15min)
- **Badges**: Shields.io endpoint badges hosted on gh-pages
