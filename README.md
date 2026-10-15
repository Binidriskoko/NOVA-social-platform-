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

Voice/video calls and live broadcasts use LiveKit rooms, with the browser connecting through `livekit-client` and the API issuing short-lived, session-scoped tokens with `livekit-server-sdk`. Call room access is limited to call participants with an active lifecycle state. Live room publishers are limited to the host; viewers receive subscribe-only tokens after joining an active session. Live sessions are not marked live until LiveKit confirms the host's camera and microphone tracks are published, and calls are not marked connected until LiveKit confirms multiple call participants are present.

Configure `LIVEKIT_URL` (`wss://` media-server address), `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` on the API. Set all three together; the API validates the URL and never sends the key or secret to browsers. Keep the media server publicly reachable over TLS with its required UDP/TCP media ports open. Browsers require HTTPS (or localhost) and user permission for camera/microphone access. The provider's ICE/TURN configuration is managed by the LiveKit deployment.

Call/live session state and authenticated server-sent events remain process-local. Run a single API instance for these features; multi-instance operation needs shared session persistence and cross-instance events. Session history is lost when the API process restarts. LiveKit provides the media plane but does not replace the app's session store or realtime lifecycle transport.
