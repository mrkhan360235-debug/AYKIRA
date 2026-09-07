# AYKIRA — durable Vercel store

The existing Node.js storefront is retained. Catalogue, orders, admin sessions and rate limits now use the existing Neon Postgres integration. Product photos uploaded in Admin use public Vercel Blob storage. Hosted requests never write to the deployment filesystem or /tmp.

## Deployment

Targets the existing Vercel aykira project linked to mrkhan360235-debug/AYKIRA. Production branch: master. Verify the feature branch deployment before merging. Node.js 24 is required. The existing Node/static builders are retained; only storefront assets and authorized API operations are exposed.

The vercel-build script runs additive migrations after checking the Vercel project identity and DATABASE_URL. Production additionally requires AYKIRA_ADMIN_PASSWORD of at least 16 characters. Tables are namespaced: aykira_v23 in Production, aykira_v23_preview in Preview. The migration never drops tables or overwrites saved catalogue rows. Preview never accepts live Razorpay keys. A separate preview database branch is still preferable.

Set these variables securely in the relevant Vercel environments:

| Variable | Purpose |
|---|---|
| DATABASE_URL | Existing Neon integration connection |
| BLOB_READ_WRITE_TOKEN | Existing public Blob store; required for photo uploads |
| AYKIRA_ADMIN_PASSWORD | Unique password of at least 16 characters, in Production and Preview |
| RAZORPAY_KEY_ID | Fresh test key in Preview; selected mode in Production |
| RAZORPAY_KEY_SECRET | Matching fresh secret; rotate the exposed V21 secret |
| RAZORPAY_WEBHOOK_SECRET | Separate webhook secret; required for live checkout |
| APP_ORIGIN | Optional canonical origin such as https://aykira.in |

System environment variables must be exposed to the build. This was enabled in the supplied dashboard screenshot. Secrets are never logged.

Set Razorpay's webhook URL to https://aykira.in/api/razorpay/webhook after domain verification, or use the current production hostname beforehand. Subscribe to payment.captured and order.paid and configure automatic capture. Only captured payments with matching order, amount and currency are confirmed. Signed webhook deliveries and customer/admin status checks recover missing browser callbacks. Cancelled status does not refund a payment.

## Domain

The domain aykira.in is owned at GoDaddy. Add it to the existing Vercel project, then copy the exact DNS record Vercel supplies into GoDaddy. Do not guess a Vercel IP or replace unrelated email/MX/TXT records. Domain configuration must be verified before calling the custom domain live.

## Content and protections

The seed preserves repository commit 11841196c5c82befd2b959f4d092f308596c836d: default upper-size price ₹1,099, Olive's custom starting price ₹799, and Colour Story's custom pricing. Eight photos are extracted and cached instead of repeatedly embedded in HTML/JSON. Previous source remains in Git history.

Admin uses HttpOnly/SameSite cookies (Secure on Vercel), CSRF tokens, database sessions and rate limits. Catalogue revisions prevent stale overwrites. The server validates prices and variants. Atomic checkout claims prevent duplicate provider orders across instances. Paid-event replays preserve fulfillment status. Customer data requires authorization or an unguessable tracking token.

Each photo is limited to 2 MB and uploaded separately to fit Vercel request limits. HTML/SVG uploads are rejected. Catalogue backup includes image bytes; restore uploads photos separately before saving. Admin lists up to 500 recent orders; full history needs database backups. Warehouse stock counts, carrier integrations, automated refunds and email/SMS delivery are not implemented.

## Verification and local use

Run npm ci and npm test. HTTP tests use mocked Razorpay responses; database tests execute real PostgreSQL-compatible SQL in local PGlite. They cover atomic edits, multi-instance order claims, sessions, preview isolation, captured-payment verification and webhook replay. No real money is charged. Local tests do not certify live Neon/Blob credentials, hosted Razorpay delivery, browser behavior or DNS.

For local development, npm run setup creates .env, then npm start runs the store. Without DATABASE_URL, local development uses data/store.json. Vercel never uses this fallback.

V21's temporary order files are not in Git. Export any existing order data and reconcile against Razorpay before retiring the old deployment. This migration adds new tables and does not delete existing data.
