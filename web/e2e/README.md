# Browser smoke (optional)

`smoke.mjs` is an optional, runnable same-origin browser check for the local
governance console. It is not part of `npm test`: it needs a built frontend and
a local Chromium.

From the repository root:

```bash
npm run build
node web/e2e/smoke.mjs
# or
npm run e2e:smoke
```

Requirements:

- Node.js 26 and `npm ci` (one workspace install).
- `dist/console/asset-manifest.json` and `dist/control-plane/cli.js` from
  `npm run build`.
- Chromium at `/usr/bin/chromium`. Override with `CHROMIUM_PATH=/path/to/chrome`.

What it does:

- Starts the real compiled governance CLI server on `127.0.0.1` with an
  ephemeral port, a brand-new temporary data directory outside the workspace,
  and synthetic in-process human/agent credentials.
- Launches headless Chromium with a fresh profile and drives the UI through the
  DevTools pipe protocol. It does not inject stores, mock `/api/*`, reuse an
  existing database, or print tokens.
- Covers: human login, project creation, Jev settings save/reload/connection test
  against a local synthetic System One provider (including `0600` credential-file
  verification), repository-seed candidate, a candidate field edit, server validation, immutable proposal submission, approval and
  publication, version YAML/JSON download verification, rollback proposal to a
  second published version, per-project version/proposal fencing, logout with
  server-session invalidation, relogin, dark/light preference, 390px mobile
  navigation with no global horizontal overflow, CSP violation events, console
  errors, runtime exceptions and 4xx/5xx same-origin responses.
- Exercises the published-rule matrix, URL filters and search through navigation
  and browser back, all four inspector tabs, read-only raw JSON, Escape/focus
  restoration and the visible, focused mobile inspector. Captures desktop and
  mobile inspector screenshots using only the synthetic test project.
- Deletes synthetic credentials, browser profile and verified downloads before
  exit. Check results and screenshots are written to a new
  `/tmp/opencode/amos-governance-e2e-*/` directory. Screenshots can show the
  repository seed rule content; treat them accordingly. No tokens are captured.

Exit codes: `0` when every check passes and no browser errors were observed,
`1` on a failed check or browser error, `0` with a `SKIP:` message when build
output or Chromium is unavailable.

Limitations: one headless Chromium only; no browser verification of server-restart persistence (covered
by control-plane tests); agents, real
credentials, real user state and non-local hosts are out of scope. The script
uses only Node built-ins and the installed Chromium, so it adds no npm
dependency. Manual acceptance can additionally use the orchestrator's
Playwright MCP browser tools; this harness intentionally does not depend on an
installed Playwright package.
