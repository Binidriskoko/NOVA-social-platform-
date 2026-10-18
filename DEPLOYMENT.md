# NOVA production deployment

The production frontend is a Vite application deployed to Vercel from the repository root, and the Express API in `server/` is deployed to Render. The frontend's SPA rewrite is configured in `vercel.json`; `server/Dockerfile` provides the API container. Do not create another service if the existing Vercel and Render services are already connected to this repository.

## Required configuration

Copy `server/.env.example` to `server/.env` and set:

- `NODE_ENV=production`
- `HOST=0.0.0.0` and `PORT=4000` (or the values supplied by the runtime)
- `DATABASE_URL` to the production PostgreSQL connection string
- `JWT_SECRET` to a unique random value of at least 32 characters, stored only in the deployment secret manager
- `REGISTRATION_DATA_ENCRYPTION_KEY` to a stable random value of at least 32 characters for encrypted private profile data; retain it across deploys and backups
- `JWT_EXPIRES_IN`, `COOKIE_NAME`, and `COOKIE_SAME_SITE`; the production default is `none` for the cross-site Vercel/Render deployment, and secure cookies require HTTPS. Use `lax` or `strict` only when the web and API are same-site.
- `CORS_ORIGIN` to one or more exact HTTPS web origins separated by commas; wildcards are rejected in production
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, and `AUTH_RATE_LIMIT_MAX`
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` together to enable calls and broadcasts; keep the API secret only in Render's secret environment

Production browser API requests use the same-origin `/api` path and are forwarded to Render by Vercel's rewrite. `VITE_API_BASE_URL` is only used by non-production builds; without it, local development falls back to the production API URL rather than localhost. The root `.env.example` contains only the safe, blank variable name.

## Vercel

Use the existing Vercel project and configure it to deploy the repository's `main` branch with the repository root as the project root. Vite's defaults use `npm ci`, `npm run build`, and `dist`; `vercel.json` rewrites `/api/*` requests to Render and browser routes to `index.html` so API calls and client-side route refreshes use the existing same-origin paths. Do not set `VITE_API_BASE_URL` for production; the production client intentionally uses these Vercel rewrites.

## Render

Use the existing Render API service; do not create a second service. The API is a Docker service with `server/` as its root directory and `Dockerfile` as its Dockerfile path. The image build runs `npm run build` to generate Prisma and compile TypeScript without needing production database access. Container startup runs `npm run db:migrate:deploy` before `npm start`, applying committed migrations without resetting application data. The server listens on `0.0.0.0` and uses Render's `PORT` when provided.

Configure the Render service environment with the required variable names listed below and in `server/.env.example`. Set `CORS_ORIGIN` to the exact HTTPS Vercel production origin(s), comma-separated if there is more than one. The API also explicitly permits the known Vercel production hostnames in `server/src/app.ts`. Store database URLs and signing keys only in Render's environment settings, never in this repository.

Render's automatic-deploy setting is configured in the service dashboard and is not represented by this repository. After pushing API route changes, verify the latest Render deployment is running the intended `main` commit; if auto-deploy is disabled, deploy that commit manually. Protected API route probes without credentials should return `401`, not `404`.

The Vercel frontend and Render API are cross-site, so production auth cookies use `SameSite=None; Secure; HttpOnly; Path=/` with the API host as a host-only cookie (no `Domain` attribute). Browsers that block cross-site cookies can still authenticate: login and registration return the session JWT over HTTPS, the frontend stores it only until its JWT expiry and sends it as a bearer token, and the API validates it against the same hashed, expiring, revocable database session. The API never logs credentials or tokens. Local development continues to default to `SameSite=Lax`.

## Production reliability limits

The API trusts exactly one reverse-proxy hop when determining the client IP so the Express rate limiter does not group unrelated visitors by the Render-facing proxy address. Keep the API behind Render's supported proxy; do not raise the trusted hop count without verifying the full proxy chain.

Render free web services spin down after a period without inbound traffic and can take time to wake. This can cause long first-request delays or provider-generated 503 responses; application retries cannot make a sleeping service continuously available. The Render service's current plan cannot be inspected from this repository. If it is on the free plan, reliable always-on production service requires changing it in the Render dashboard to an always-on paid instance. Do not use periodic source-code pings as a substitute for that availability setting.

The browser API client retries safe reads at most twice after transport failures or temporary gateway responses, with exponential backoff and jitter. Non-JSON gateway responses and Cloudflare challenge pages are surfaced separately from JSON application errors and JSON rate limits; a Cloudflare challenge is generated before Express handles the request.

## PostgreSQL and Prisma

Create an empty PostgreSQL database and grant the application user only the permissions required by the application. From `server/`, run:

```sh
npm ci
npm run db:generate
npm run db:migrate:deploy
npm run db:migrate:status
```

`db:migrate:deploy` applies committed migrations without resetting data. The production container runs this command before starting the API. Do not use `db:push` or `migrate dev` against production.

## Build and start

Backend (set `DATABASE_URL` in the runtime environment before migrating or starting the API):

```sh
npm --prefix server ci
npm --prefix server run db:generate
npm --prefix server run db:migrate:deploy
npm --prefix server run build
npm --prefix server start
```

`npm --prefix server run build` never applies migrations. Run `npm --prefix server run db:migrate:deploy` against the intended database as a deployment/release step, then verify it with `npm --prefix server run db:migrate:status`. The production Docker container runs the deploy command on startup.

Frontend:

```sh
VITE_API_BASE_URL=https://api.example.com npm ci
VITE_API_BASE_URL=https://api.example.com npm run build
```

The included `docker-compose.production.yml` builds the API and Nginx web service. Set `VITE_API_BASE_URL` in the environment used by Compose and keep `server/.env` outside version control. The API health check is `GET /api/health`; the web container health check is `GET /health`.

## Domains and realtime

Point the web domain at the Nginx service and the API domain at the Express service. Set `CORS_ORIGIN` to the web origin exactly, including scheme and port where applicable. Keep HTTPS termination in front of both services. Messaging realtime currently uses authenticated Server-Sent Events at `/api/realtime`; the proxy must allow long-lived connections, forward cookies, disable response buffering for that route, and permit keep-alive connections.

Calls and live broadcasts use the integrated LiveKit client and server SDK. LiveKit itself must run as a separately reachable media service; Vercel static hosting and the existing Render HTTP API do not host an SFU. Configure its public TLS WebSocket URL in `LIVEKIT_URL` and its matching API key and secret in Render. The API issues 10-minute participant tokens after checking call/session membership and lifecycle state; the browser receives only the URL and signed token. LiveKit handles ICE/TURN and its media-server configuration must allow the required UDP/TCP media traffic.

Call/live session lifecycle, viewer presence/counts, and the realtime event hub are still process-local. Run one API instance for these features; API restarts lose active broadcasts and multi-instance deployment needs shared session storage and cross-instance events. Live comments/reactions, finalized replay metadata, and replay posts use PostgreSQL, but their availability does not make active broadcasts durable. This integration does not provision or deploy a LiveKit service.

Live replay capture uses the host browser's `MediaRecorder` on the camera and microphone tracks published to LiveKit. It depends on browser support, permissions, and a completed upload; unsupported browsers, interrupted captures, and uploads rejected by the 100 MB media endpoint do not produce a replay choice. Finalized replay bytes use the existing PostgreSQL media-storage adapter, and the replay is marked ready only after storage and metadata writes succeed. This is client-side recording, not LiveKit server-side archival. The media ingress limit and PostgreSQL capacity for large recordings remain unverified against production services. Configure `DATABASE_URL` plus `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in Render; no additional media provider is introduced. Before production use, test actual multi-device publishing/playback, microphone/camera denial, viewer join/leave, network interruption, replay upload/playback/deletion, and media-server/API restarts against the configured services.

Registration is password-based and does not require email verification, phone verification, an OTP, or a paid provider. Users may choose a username and password and optionally add an email address or phone number; login accepts the username, email address, or phone number with that password. Passwords are stored as bcrypt hashes, and successful registration/login establish revocable, server-tracked sessions in secure HTTP-only cookies. Optional MFA can be introduced later through the existing `MfaMethod` model without making verification a prerequisite for account creation.

AI assistance endpoints also return HTTP 503 until a real AI provider is integrated. They do not return generated-looking placeholder summaries, captions, or replies.

## User media

Authenticated image uploads use `POST /api/media/uploads` with a `file` form field. JPEG, PNG, and WebP inputs up to 10 MB are decoded, orientation-corrected, resized, and re-encoded as WebP. Video uploads use the authenticated `POST /api/media/videos` endpoint with a server-enforced 100 MB limit; message video clients use this endpoint too. Voice, PDF, and DOCX uploads remain limited to 10 MB on `POST /api/media/attachments`. The server validates authentication, MIME type, extension, and file signature. The existing production adapter buffers each upload in application memory and stores bytes in PostgreSQL. Vercel documents a 4.5 MB request/response limit for Vercel Functions, but this repository forwards `/api/*` through an external rewrite to Render rather than a Vercel Function. Render's published web-service documentation does not specify an inbound request-body maximum. The deployed ingress limit and PostgreSQL capacity for 100 MB are therefore unverified until an end-to-end upload test against the actual services. A streaming object-storage adapter is needed to avoid buffering large videos. Production never falls back to process memory.

## Payments

Payment records are provider-agnostic and remain `PENDING` until a real provider integration confirms payment. No provider credentials are included. Before enabling public checkout, configure the chosen provider's account, API key, webhook signing secret, and event endpoint in the deployment secret manager; implement signature verification, raw-body handling, replay protection, and writes to `PaymentWebhookEvent` using `(provider, providerEventId)` as the idempotency key. Never mark a payment paid from a browser request alone.

## Security checklist

- Use a unique production `JWT_SECRET`; never use example or development values.
- Use HTTPS, secure cookies, exact CORS origins, and a restricted database role.
- Run migrations before accepting traffic and confirm `/api/health` reports `database: ok`.
- Keep application logs free of passwords, tokens, payment secrets, and unnecessary personal data.
- Configure a reverse proxy timeout and buffering policy suitable for SSE.
- Rotate secrets through the deployment secret manager, not repository files.

## Verification

After deployment, verify `GET /api/health` returns HTTP 200 with `status: ok` and `database: ok`, load the web domain, register with a username/password and community rules accepted, log in with the username or optional phone/email, create a post, send a message, open the realtime stream, and confirm an admin-only endpoint rejects a normal user. Inspect logs for startup and database errors without exposing secret values.

## Android APK releases

The stable public download page is <https://github.com/Binidriskoko/NOVA-social-platform-/releases/latest>. Android uses the Render API directly at `https://nova-social-platform-api.onrender.com`; browser production continues to use the Vercel same-origin `/api` rewrite. Android update discovery reads `public/release-metadata.json` from the public `main` branch and only shows an update inside the Android app when its version code is newer. The notice opens the stable Releases page. Android still requires users to approve APK installation; this is not a silent self-update mechanism.

Before a release tag is created, update `versionCode` and `versionName` in `android/app/build.gradle`, the matching `ANDROID_VERSION_CODE` and `APP_VERSION_NAME` in `src/config/release.ts`, and all fields in `public/release-metadata.json` to that release. Keep these version values synchronized, use the official Releases page URL, and include the release notes/date. Then push the commit and its matching `vMAJOR.MINOR.PATCH` tag. The `Android Release` workflow builds web assets, syncs Capacitor, signs and validates the APK, generates its SHA-256 checksum, and creates a GitHub Release with both files. The script can also be run locally with Node.js 22+, JDK 21, Android SDK platform/build-tools 35, and the same signing environment:

```sh
export ANDROID_KEYSTORE_PATH=/secure/path/to/original-release.jks
export ANDROID_KEYSTORE_PASSWORD=...
export ANDROID_KEY_ALIAS=...
export ANDROID_KEY_PASSWORD=...
npm ci
npm run android:release
```

Do not create or substitute a signing key. The repository's existing public APK and the v1.0.0 GitHub Release asset use an Android Debug certificate with SHA-256 fingerprint `C8:1B:27:66:C7:00:A3:7A:09:6C:7A:26:F4:F9:2D:A7:34:80:F5:5F:62:21:D1:C6:60:AC:90:F4:50:80:07:DE`. The build script and workflow refuse any signing certificate that differs from it, because Android requires the same certificate for an in-place update. That certificate's private key was not found in the workspace; a matching key must be recovered and stored in the GitHub repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` before the workflow can publish a compatible update. Do not label or distribute an APK signed by a different key as an update to existing installs.
