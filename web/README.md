# Rackpath v2 web app

React, TypeScript and Vite. Built to static files that the Rust server
(`api-rs/`) serves next to the API, so production is one program and one
container.

```bash
npm ci
npm run dev        # http://localhost:5173, proxies /api to the server on :8080
npm run build      # typecheck, then dist/ (point RACKPATH_WEB_DIR at it)
node e2e/run.mjs   # browser tests against ../api-rs/target/release/rackpath
```

To run the server for development:

```bash
cd ../api-rs
RACKPATH_ENCRYPTION_KEY=$(openssl rand -hex 32) RACKPATH_WEB_DIR=../web/dist cargo run
```

- `src/api.ts`: the only way the app calls the server (same-origin, session cookie).
- `src/auth.tsx`: sign-in state, including two-factor and forced password change.
- `src/ui.tsx`: the component kit (buttons, fields, dialogs, tables, tabs, toasts).
- `src/styles/tokens.css`: colours and fonts, shared with v1's look (light and dark).
- `e2e/`: Playwright tests that drive the real server with a fresh database.
