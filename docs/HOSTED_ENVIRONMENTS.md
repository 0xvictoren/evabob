# Hosted testnet on Vercel

Evabob testnet is prepared as two Vercel projects from this repository:

| Project | Root directory | Purpose | Intended domain |
|---|---|---|---|
| `evabob-web-testnet` | repository root | Next.js public app, `/pay/{id}`, `/claim` | `https://testnet.evabob.app` |
| `evabob-api-testnet` | `server` | Hono API, Circle and Arc integrations | `https://api-testnet.evabob.app` |

MongoDB Atlas is the authoritative database for the API. Vercel's writable
filesystem is temporary, so `DATA_DIR=/tmp/evabob` is only a per-instance
mirror. Uploads must move to object storage before profile-photo uploads are
considered durable on hosted testnet.

## Environment boundaries

| Setting | Local | Testnet | Production |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` |
| `EVABOB_ENV` | `local` | `testnet` | `production` |
| API origin | local HTTP | exact Vercel HTTPS API origin | exact production HTTPS API origin |
| Browser CORS | local origins | only the public testnet web origin | only the production web origin |
| Mongo database | optional | required `evabob_testnet` | required `evabob` |
| Header auth | local opt-in only | `false` | `false` |
| Launch flag | off | off | locked until reviewed |

Hosted startup fails when header impersonation is enabled, CORS is wildcard or
non-HTTPS, Mongo is absent, a public URL is not an exact HTTPS origin, the Safe
address is absent, or the three hot signer keys are invalid/reused.

## Deploy the API project

1. Import this repository into Vercel and set Root Directory to `server`.
2. Start from [`server/.env.testnet.example`](../server/.env.testnet.example).
3. Set Atlas, exact origins, `CRON_SECRET`, Dynamic, Circle, and the three
   separated testnet signer values.
4. Enable only capabilities that passed in this environment. Bank/card top-up,
   cash out, WhatsApp, conversion, bridge routes and batch agent sends remain
   disabled by default.
5. Deploy, then require both `/health/live` and `/health/ready` to return 200.

`server/src/index.ts` exposes the Hono application as the default export used by
Vercel's native Hono adapter. `server/vercel.json` enables Fluid compute and
invokes the refund sweep hourly using Vercel Cron. Vercel sends
`Authorization: Bearer $CRON_SECRET` to that route.

## Deploy the public web project

1. Create another Vercel project with the repository root as Root Directory.
2. Set `EVABOB_API_BASE_URL` and `NEXT_PUBLIC_API_BASE_URL` to the API origin.
3. When signed builds have stable URLs, set `NEXT_PUBLIC_ANDROID_APP_URL` and
   `NEXT_PUBLIC_IOS_APP_URL`.
4. Add the web origin to Dynamic and API CORS as an exact allowed origin.

The public pages use limited unauthenticated status endpoints. They never mark
a payment paid: the authenticated app submits a transaction hash, and the API
verifies its receipt before changing an invoice state.

## Mobile testnet build

Build with public values only:

```text
API_BASE_URL=https://api-testnet.evabob.app
DYNAMIC_APP_ORIGIN=https://testnet.evabob.app
ALLOW_DEMO=false
```

No Circle secret, signer key, Mongo URI, Dynamic API token or Cron secret
belongs in Flutter.

## Vercel limitation that remains open

The current store is one process-global snapshot mirrored to Mongo under a
single writer lease. Vercel can create several function instances. A second
writer therefore fails closed rather than corrupting data, but that can produce
cold-start failures. This is suitable only for low-traffic internal testing.
Before a larger test, normalize financial records into Mongo collections with
database-level atomic/idempotent writes and remove process-global state.

The hourly Cron replaces the container timer, but Vercel does not make other
long-running background loops durable. Pending Circle/App Kit jobs must remain
recoverable by app polling or move to a dedicated queue/worker.

## Smoke checks

```text
GET https://api-testnet.evabob.app/health/live
GET https://api-testnet.evabob.app/health/ready
GET https://api-testnet.evabob.app/v1/config/public
GET https://testnet.evabob.app/api/health
GET https://testnet.evabob.app/pay/<known-request-id>
GET https://testnet.evabob.app/claim?token=<known-transfer-id>
```

Verify allowed and rejected CORS origins separately. A rejected origin must not
receive `Access-Control-Allow-Origin`.
