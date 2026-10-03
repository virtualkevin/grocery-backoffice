# Grove — produce purchasing agents

A local hackathon demo for a fictional grocery store in San Francisco's Mission District (ZCTA 94110). Two purchasing agents evaluate 24 produce SKUs against eight simulated supplier businesses. The application shows operator and authorized local god views, negotiation outcomes, budget accounting, market evidence, and an approved produce flyer.

All purchases are simulated. Supplier names, stock, quotes, forecasts, and store inventory are fixture data. The application does not place real orders.

## Run locally

Use Node 22.13 or newer. This workspace has Node 24.21 installed through nvm:

```sh
export PATH=/home/nvidia/.nvm/versions/node/v24.21.0/bin:$PATH
npm install
npm run dev
```

In a second terminal:

```sh
export PATH=/home/nvidia/.nvm/versions/node/v24.21.0/bin:$PATH
npm run dev:ui
```

Open [the development interface](http://127.0.0.1:5173). The API listens on `127.0.0.1:3001` and the frontend proxies `/api` requests there.

For a single-process presentation:

```sh
npm run build
npm start
```

Open [the built application](http://127.0.0.1:3001). Keep the persistent Node process running; the SQLite ledger is in the ignored `data/` directory.

## Demonstration

1. Start an explicitly labeled **Simulation** with the default $2,000 purchasing budget.
2. Watch all 24 decisions settle. The seeded highlights are apples purchased within budget, strawberries approved after a manager budget request, and avocados unavailable within the item cap.
3. Inspect the supplier comparison and a selected item's alternatives. Open local god mode to inspect private supplier targets and constraints.
4. Review and approve the three-product promotion plan, then compose the flyer. Prices, units, dates, and quantity caps come from the frozen approved revision; artwork was generated in advance.
5. Start a new run to reset the scenario. Cancel an in-progress run before starting a replacement when appropriate. Cancellation preserves completed purchases and releases unused reservations. After a server restart, unfinished runs are marked interrupted; start a fresh run rather than resuming cloud work implicitly.

## Live integration readiness

ZooWork provides role-specific reasoning; Band transports messages between independent identities. **Live mode stays blocked until all eleven identities are connected and ZooWork is ready.** A connected/readiness result does not by itself prove a successful full live rehearsal. Simulation never silently substitutes for failed live requests.

Local `.env` is ignored and must have owner-only permissions (`chmod 600 .env`). `.env.example` contains variable names only. Keep keys out of client code, logs, screenshots, and commits.

The existing manager uses `BAND_AGENT_ID`, `BAND_API_KEY`, and `BAND_AGENT_HANDLE`. Ten additional role prefixes are provided, each with `_AGENT_ID`, `_API_KEY`, and optional `_AGENT_HANDLE`:

- `BAND_FRUIT_BUYER`, `BAND_VEGETABLE_BUYER`
- `BAND_SUPPLIER_WHOLESALE`, `BAND_SUPPLIER_FARM`, `BAND_SUPPLIER_ORGANIC`, `BAND_SUPPLIER_SURPLUS`
- `BAND_SUPPLIER_FRUIT`, `BAND_SUPPLIER_COOP`, `BAND_SUPPLIER_IMPORT`, `BAND_SUPPLIER_RAPID`

After entering missing values locally, either restart the API or refresh its singleton provider service:

```sh
curl -X POST http://127.0.0.1:3001/api/providers/refresh
```

The response contains sanitized readiness and missing-role information, never credentials. Do not run another Band probe using the same identities while the application owns their connections.

ZooWork resources and sessions are isolated by role/run. Manager allocations, buyer choices/counteroffers, supplier quotes, and budget decisions are validated before changing business state. Supplier private model output is not copied into public dialogue; public events are rendered from typed actions. Model actions cannot raise the total budget or bypass price floors, stock, specification, delivery, or per-intent uniqueness constraints.

## Evidence and limitations

- **USDA AMS:** authenticated current/history observations are retrieved from Los Angeles Terminal Market Fruit Prices, report 2306, for up to five matching fruit commodities. San Francisco terminal reports were discontinued in May 2025, so Los Angeles is explicitly labeled a **geographic proxy**. Comparisons require matching package, grade, variety, origin, size, organic status, condition, quality, and market. Commodity benchmarks can differ from the fictional store specification and are not executable supplier quotes.
- **Census:** a verified 2020 DHC P9 record for ZCTA 94110 is shipped from the official national Census archive (68,336 residents; 22,160 Hispanic or Latino). Geography and table rows were joined by log-record identifier and checked against the official matrix. It is labeled cached official data with its 2020 observation date. The direct API currently requires an optional `CENSUS_API_KEY`; the verified archive fallback works without one. These aggregate counts are context, not deterministic product preferences.
- **Store demand and seasonality:** the simulated October 4–5 fall produce weekend applies +10% to the apple forecast, capped at four units, before whole-case rounding (44→48 forecast; 44 net units; two 40-unit cases). Other items retain baseline forecasts. These are dated scenario assumptions, not observed store sales or live event discovery. No deterministic demographic purchasing multiplier is applied.
- **Flyer:** saved AI-generated artwork with application-rendered approved text; on-demand image regeneration, PDF export, and deployment are deferred.

Observed dates, fetch times, scenario dates, and live/cached-live/fixture provenance remain distinct. Cached evidence is not relabeled as freshly observed.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

Tests cover all 24 SKU decisions/eight suppliers, fixture feasibility, different quote IDs racing for one intent, budget/stock rollback, duplicate acceptance, cancellation and restart, exact rational money calculations, HTTP/SSE privacy, local god authorization, provider concurrency, and the complete live orchestration path using an explicitly injected test transport. The test transport is not evidence of real Band delivery.

With both development servers running and Chromium available:

```sh
CHROMIUM_PATH=/home/nvidia/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome npm run test:ui
```

On another machine, install the matching browser with `npx playwright install chromium` and omit `CHROMIUM_PATH`.

The browser rehearsal covers the purchasing flow, comparison view, god session, promotion/flyer approval, reload consistency, and mobile layout. It saves screenshots under `/tmp/grove-ui` by default. See the script for browser executable and base-URL overrides.

## Social-interest signals

Open **Social trends**, choose one of five produce topics, and select **Refresh signals** to fetch TikTok and X through Glasser. Startup reads the last saved report without paid calls. Refresh makes two bounded provider requests, validates pricing, and enforces a five-minute cooldown; partial failures remain visible. The initial real two-platform search cost $0.002980 and returned 20 linked records. A post is eligible for purchasing only if its publication date is known and within 14 days, and the report was fetched within 24 hours. Older/undated posts remain evidence only.

When starting a **new** run, social-interest adjustment is off by default. Opting in treats recent posts as an operator hypothesis, not measured growth or proven local demand: at most three mapped SKUs receive a 5% forecast adjustment capped at two forecast units each. The backend previews the exact whole-case effect before opt-in, using the same calculation as purchasing. For cucumbers, forecast 40→42 produces planned orders 36→72 units (one→two cases). The two-unit cap is **not a purchase-quantity cap**. Supplier availability, budget, specifications, delivery and remaining shelf-life checks still govern acceptance; they do not prove excess units will sell. New runs freeze their evidence; refreshing never alters historical decisions or flyers.

The quality pass also added server-side god-session expiry, cancellation fences for delayed Band sends, safe shared room provisioning, explicit unconfirmed receipts after interruption, and a guard against composing a cancelled promotion. Isolated API tests with the actual cached Glasser report verified opt-in/off quantities and balanced ledgers without altering the completed live run.

## Verification status

The local application is implemented and running at [the production demo](http://127.0.0.1:3001), with [the development preview](http://127.0.0.1:5173) also available. `npm run typecheck`, `npm test`, and `npm run build` pass. **The 49 tests in `npm test` include 14 integration-adapter tests and eight Glasser-adapter tests**; these are not separate totals to add together. The browser rehearsals verify both the complete simulation and the final actual live run: private-path rejection, Census/USDA evidence, operator/god views, confirmed receipts, exact approved flyer, reload, and mobile layout.

The current build passed a full **actual ZooWork + Band run in 146.615 seconds**: all eleven independent roles completed reasoning, all eight suppliers responded, and all 24 SKU decisions resolved. It selected 23 simulated purchases with 23 confirmed supplier receipts and one budget walkaway. ZooWork completed 23 reasoning calls; Band sent, received, and processed 82 messages. There were zero provider or technical failures. The ledger committed **$974.72**, released all remaining reservations, and passed independent stock, price-floor, and public-privacy checks. Apples won within budget, strawberries received a manager-approved increase, and avocados remained unavailable within their cap. See `server/integrations/verification.json` for sanitized provider evidence.

A subsequent **real Playwright end-to-end run with social opt-in** also passed: visible browser controls refreshed both Glasser platforms (16 source-linked results), showed the exact quantity preview, and started one actual ZooWork/Band run. It completed all 24 decisions with eight suppliers, 23 confirmed receipts, **$997.95 committed**, zero remaining reservations, and zero technical/provider failures. Cucumber purchases were 72 units, matching the 36→72 whole-case preview. The three intended outcomes, ledger/stock/floors/privacy checks, and frozen trend provenance passed. The previous completed live run remained byte-for-byte equivalent in business state. The same browser run approved and composed the exact-price flyer, verified reload/mobile/god access, and recorded zero JavaScript or console errors. No synthetic transport was substituted. Browser evidence is saved in `/tmp/grove-real-e2e/report.json` and `/tmp/grove-real-e2e/trace.zip`.

The application preserves earlier failed rehearsal records. Those exposed unsupported Band message metadata, buyer room-invitation permissions, and a model choice referencing another SKU’s quote. The current implementation sends supported content/mention fields, has the manager provision private pair rooms, and preserves valid buyer lines while correcting only invalid lines once. An unresolved line becomes a technical failure without aborting the other decisions.

Acceptance notifications are stored atomically with each live purchase; an identity-matched supplier acknowledgment marks the receipt confirmed. Missing or invalid acknowledgment leaves the purchase committed and explicitly unconfirmed. Completed runs preserve the evidence used for their decisions; refreshing providers updates future research only. All purchasing remains simulated despite real reasoning and transport.

All eleven credentials are now configured locally. For a fresh installation, each additional role prefix requires **`_AGENT_ID` and `_API_KEY`** (`_AGENT_HANDLE` is optional); keep the existing manager names unchanged. The manager must be permitted to create rooms and invite the known task agents. It provisions the two manager/buyer pairs and twelve eligible buyer/supplier pairs; each buyer/supplier still sends with its own identity. The additional agents’ private/registry settings do not need to be widened. After changing credentials, call `POST /api/providers/refresh` and reload the interface; inspect `GET /api/capabilities`. The optional local god-authorized `POST /api/providers/probe` checks all fourteen fixed pairs without ZooWork inference.

Production browser verification uses the same test script:

```sh
BASE_URL=http://127.0.0.1:3001 CHROMIUM_PATH=/home/nvidia/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome npm run test:ui
```

A separate **real-provider** browser test uses visible controls to refresh both social platforms, opt into the quantity preview, start one live run, and approve its flyer. It is excluded from default tests and requires an explicit flag because it makes provider calls:

```sh
BASE_URL=http://127.0.0.1:3001 CHROMIUM_PATH=/home/nvidia/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome node tests/live.browser.mjs --live-providers
```

## Local API

- `GET /api/bootstrap`, `GET /api/capabilities`, `GET /api/health`
- `GET /api/trends`, `POST /api/trends/refresh` with an allowlisted `skuId`
- `POST /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events`
- `POST /api/session/god` with `{"enabled":true}`, `DELETE /api/session/god`
- `GET /api/runs/:id/god`, `GET /api/runs/:id/god/events`
- `POST /api/runs/:id/cancel`
- `POST /api/runs/:id/approve` with the current promotion `revision`
- `POST /api/runs/:id/flyer`, `GET /api/runs/:id/flyer/preview`
- `POST /api/providers/refresh`
- `POST /api/providers/probe` with an authorized local god session; fixed task-role pairs only

God access is a server-checked demo session, not production authentication. The server binds only to loopback and rejects foreign-origin mutations. A private reverse proxy can use the exact `APP_PUBLIC_ORIGIN` configuration; arbitrary Host headers do not grant access. A public deployment would require a production identity/access model.


## Private Tailscale access on the demo host

Open **http://100.100.80.11:3001** from another device connected to the same tailnet and permitted by its access policy. The app remains bound to `127.0.0.1:3001`. A systemd socket proxy listens only on this host’s Tailscale address and forwards to loopback; there is no public listener or Funnel. HTTP travels inside the encrypted Tailscale connection. `APP_PUBLIC_ORIGIN=http://100.100.80.11:3001` admits that exact browser origin while preserving foreign-origin rejection.

The installed user units are `grocery-backoffice.service`, `grocery-backoffice-tailnet.socket`, and `grocery-backoffice-tailnet.service` under `~/.config/systemd/user`. They survive terminal and agent exit and start with the user manager. User lingering is disabled on this host, so a full logout can stop them; this setup does not promise availability before login after a reboot. To inspect or restart the app:

```sh
systemctl --user status grocery-backoffice.service grocery-backoffice-tailnet.socket
systemctl --user restart grocery-backoffice.service
```

Tailscale Serve HTTPS could replace the private socket proxy after an administrator authorizes Serve on this host. It currently requires sudo and was not enabled. The browser was checked through the private HTTP address for assets, current saved run, SSE, God-mode grant/revoke, reload, and foreign-origin rejection without creating a run or making paid provider calls. A second physical device still depends on the tailnet’s access policy.
