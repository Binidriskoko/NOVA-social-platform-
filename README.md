# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Messaging and real-time media

Group conversations created from the Messages page are persisted with an explicit group flag. Owners and moderators can add directory members from the group header; direct one-to-one conversations cannot be expanded this way. Apply the schema changes before deploying:

```sh
cd server
npm run db:migrate:deploy
```

Voice/video calls and live broadcasts use browser WebRTC peer connections. WebRTC encrypts media with DTLS-SRTP; authenticated, participant-scoped server-sent events relay SDP and ICE signaling. Calls support up to seven remote participants. Live video is sent directly from the host to each viewer, so its upload bandwidth and host CPU usage grow with the audience; this built-in implementation is intended for small audiences, not large-scale broadcast distribution.

Browsers require HTTPS (or localhost) and user permission for camera/microphone access. STUN is used for direct peer discovery by default. Networks that block direct connectivity need a TURN server; a free, self-hosted Coturn deployment can use time-limited REST credentials. Configure `TURN_URLS` as comma-separated TURN URLs and set `TURN_SHARED_SECRET` to Coturn's REST shared secret. The server derives expiring client credentials and never returns the shared secret. `TURN_USERNAME_PREFIX` and `TURN_CREDENTIAL_TTL_SECONDS` are optional.

The current call/live session registry and signaling event hub are process-local. Run one backend instance for these features; horizontal scaling or serverless deployment requires shared session storage and a cross-instance pub/sub/WebSocket signaling service. Call/live session history is transient and is lost when that process restarts. No paid media provider is required or configured.
