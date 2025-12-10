## Testnet Sentinel (datahaven-monitor)

- [![Sanity – Connection](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/connection.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Health](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/health.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Auth (SIWE)](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/auth.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Bucket Create](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/bucket-create.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Storage Request](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/storage-request.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – File Upload](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/file-upload.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – File Download](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/file-download.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – File Delete](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/file-delete.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)
- [![Sanity – Bucket Delete](https://img.shields.io/endpoint?url=https://ftheirs.github.io/datahaven-monitor/bucket-delete.json)](https://github.com/ftheirs/datahaven-monitor/actions/workflows/monitor-cron.yml)

Testnet Sentinel runs comprehensive end-to-end monitoring of StorageHub functionality,
testing the full lifecycle: connection, authentication, bucket management, file storage,
and cleanup. Each stage is monitored and badged independently.

### Quick start (local)

- **Install Bun** (see [Bun documentation](https://bun.sh)).
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
4. **Bucket Create**: Create bucket on-chain and wait for MSP indexing
5. **Storage Request**: Issue storage request with proper chain finalization waits
6. **File Upload**: Upload file after MSP readiness (with retry logic and fulfillment wait)
7. **File Download**: Download and verify file integrity via fingerprint matching
8. **File Delete**: Request deletion, wait for on-chain event, and verify MSP cleanup
9. **Bucket Delete**: Delete bucket and verify removal from chain and MSP

Each stage runs independently and reports its status (passed/failed/skipped) to generate
dynamic badges. The monitor uses proper wait mechanisms for chain finalization and backend
indexing to handle public network constraints.

### Badge System

Badges are generated as [Shields.io endpoint JSON](https://shields.io/endpoint) files and published to GitHub Pages. Each stage produces:
- Individual badge: `badges/<stage-name>.json`
- Summary badge: `badges/status.json`

Badges update every 15 minutes via GitHub Actions.

### Technology

- **Runtime**: Bun + TypeScript
- **SDKs**: `@storagehub-sdk/core`, `@storagehub-sdk/msp-client`
- **Chain interaction**: Polkadot.js API (Substrate) + Viem (EVM)
- **CI/CD**: GitHub Actions with 15-minute cron schedule
- **Badges**: Shields.io endpoint badges hosted on gh-pages

### Key Features

- **Robust wait mechanisms**: Proper chain finalization waits and MSP backend polling
- **Event listening**: Waits for on-chain events (StorageRequestFulfilled, FileDeletionRequested)
- **Fingerprint verification**: Downloads are verified against original file fingerprints
- **Automatic cleanup**: Resources are cleaned up even on failure
- **Network flexibility**: Supports both stagenet and testnet configurations
- **Comprehensive logging**: Each stage reports detailed progress and timing

### Troubleshooting

If stages fail:
- **Connection**: Check network connectivity and RPC endpoints
- **Auth**: Verify account private key is valid and has permissions
- **Upload**: MSP may need time to process storage requests (15s default wait + retries)
- **Delete**: File/bucket deletion requires on-chain events and MSP processing time

For local debugging, increase delays in `src/monitor/config.ts` if needed.
