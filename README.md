# Freebuff Adapter

A local daemon + monochrome dark web UI that ports the **Freebuff** free-model
flow to any OpenAI-compatible client. It owns the parts of the official client
that a raw OpenAI request cannot carry:

1. **Device-code login** — requests a login code from `freebuff.com`, opens
   your browser, polls until you sign in, and persists the token.
2. **Session admission** — claims a server-side 1-hour session slot
   (`POST /api/v1/freebuff/session`) and polls it every 30 s.
3. **Ad impressions** — fetches ads, shows them in the UI (the UI *is* the ad
   viewer), and reports every impression once (`/api/v1/ads/impression`),
   exactly the way the official client's `use-gravity-ad` hook does.
4. **Daily streak check-in** — reads `GET /api/v1/freebuff/streak` once per
   Pacific day (the streak day boundary) and shows your streak in the UI;
   failures are reported but never fatal, mirroring the official client.
5. **OpenAI-compatible proxy** — `POST /v1/chat/completions` that injects
   `providerOptions.codebuff.codebuff_metadata.freebuff_instance_id`
   (plus `run_id`, `client_id`, `cost_mode: "free"`) into every upstream call,
   so the server-side session gate lets the request through.

The UI shows **all tasks, reports, logs, errors and warnings** in one console,
plus the ad viewer, proxy info, and a test chat box.

Zero runtime dependencies — plain Node.js (≥ 18.17, uses global `fetch`,
web streams, and `crypto.randomUUID`).

```
login → session → ads (shown + impressions) → daily streak check-in → chat/completions (gated on instanceId)
```

## Quick start

```bash
cd freebuff-adapter
node src/index.js          # or: npm start
```

Then open <http://127.0.0.1:8899> and click **LOG IN**. The daemon requests a
login code, opens your browser (the URL is also shown in the UI — paste it
manually if auto-open fails), and polls until you sign in with Google/GitHub.

After login the daemon:

- admits a session for the selected model (`deepseek/deepseek-v4-pro` by default),
- starts rotating ads every 60 s, showing them in the ad viewer and reporting
  one impression per ad shown (deduped by `impUrl`),
- starts listening for chat requests.

Point any OpenAI-compatible client at the proxy:

```bash
# curl
curl -N http://127.0.0.1:8899/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash",
       "messages":[{"role":"user","content":"hello"}],
       "stream":true}'

# OpenAI SDK
client = OpenAI(base_url="http://127.0.0.1:8899/v1", api_key="unused")
```

Or use the **test chat box** in the UI, which shows the injected
`freebuff_instance_id` and streams the reply.

### Desktop app (Electron shell)

Wrap it in a small desktop window that auto-starts the daemon:

```bash
cd freebuff-adapter/desktop
npm install
npm start            # spawns the daemon, waits for health, opens the UI window
```

The shell (`desktop/main.js`) spawns `src/index.js` as a child with the same
env/config, shows a real window (auto-generated monochrome icon, ad clicks open
in your system browser), and on quit tells the daemon to shut down gracefully
via `POST /api/shutdown` so the Freebuff session is released first. If a daemon
is already running on the port it just attaches to it and leaves it alone.From the repo root: `npm run desktop`.

**Build a real installer** (electron-builder, current platform):

```bash
cd freebuff-adapter/desktop
npm install
npm run dist        # → dist/Freebuff Adapter Setup <ver>.exe (NSIS installer)
                    #   + dist/Freebuff Adapter Portable <ver>.exe (single-file, no install)
                    #   + dist/win-unpacked/
```

or from the repo root: `npm run dist:desktop`. The build ships the daemon and
UI **unpacked** under `resources/daemon` (`extraResources`) because the shell
spawns them as a child process, which cannot read files inside `app.asar`;
the packaged shell locates them via `process.resourcesPath`. The packaged app
runs the daemon on **Electron's bundled Node.js** (`ELECTRON_RUN_AS_NODE`), so
end users need no separate Node install — only dev runs (`npm start` from the
repo) require `node >= 18.17` on PATH.

**CI (GitHub Actions):** `.github/workflows/ci.yml` runs the daemon syntax
check + full test suite on every push/PR (Node 18/20/22 × Linux/Windows).

**Release builds (GitHub Actions):** push a `v*` tag and
`.github/workflows/build-windows.yml` builds on `windows-latest` (daemon tests
→ `npm run dist`) and attaches the installer + portable exe to a GitHub
Release for that tag. Run it manually via the workflow's *Run workflow*
button: fill in `tag_name` (e.g. `v0.1.0`) to publish a Release, or leave it
empty to just build and download the installers from the run's artifacts.

**Signing:** the build produces **unsigned** installers — Windows SmartScreen
will show its "unknown publisher" warning on install. Code-signing
certificates that Windows trusts are all paid (Azure Trusted Signing ~$10/mo,
OV/EV certs from a CA), so this repo deliberately ships unsigned by default.

The one free route to a real signature: **SignPath** grants free code signing
to approved open-source projects (their CI action signs your artifacts with a
certificate Windows trusts). If you want that, see signpath.io — wire their
GitHub Action into `build-windows.yml` before the artifact upload step. Note
that even signed installers can show a SmartScreen prompt until the publisher
has enough download reputation; the "unsigned" block is what disappears.

Useful extras:
- `PORT=8898 npm start` — run the shell on another port (env is passed through).
- `npm start -- --screenshot shot.png` — load the UI, capture the window, quit
  (handy for CI or a quick visual check).

### Live-backend smoke test

Proves the real flow end-to-end against the live server: token validation,
session adopt/admit, ads fetch (read-only, no impressions), and one minimal
chat through the proxy to verify the free-mode gate still passes. Uses the
daemon's credential precedence (port state → official CLI credentials →
`CODEBUFF_API_KEY`); admits a session only if none is active, and releases it
after. Opt-in so `npm test` stays hermetic:

```bash
# PowerShell:  $env:FREEBUFF_LIVE=1; npm run test:live
FREEBUFF_LIVE=1 npm run test:live
```

### Try it offline (mock upstream)

No Freebuff account needed — spins up an in-process fake backend:

```bash
FREEBUFF_MOCK=1 node src/index.js
# login auto-approves after a couple of polls; ads + chat are canned.
FREEBUFF_MOCK_CHAOS=1 ...   # rejects the first chat call with 410 to exercise gate re-admission
```

## Configuration (env vars)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `FREEBUFF_PORT` | `8899` | HTTP listen port (binds to `127.0.0.1`) |
| `HOST` / `FREEBUFF_HOST` | `127.0.0.1` | Listen address |
| `FREEBUFF_BASE_URL` | `https://freebuff.com` | Backend base for the login endpoints (`/api/auth/cli/*`) |
| `FREEBUFF_APP_URL` | `https://www.codebuff.com` | Backend base for the API surface: token validation, session, ads, usage (`/api/v1/*`) |
| `FREEBUFF_CHAT_BASE_URL` | = `FREEBUFF_APP_URL` | Backend base for chat-completions |
| `CODEBUFF_API_KEY` | — | Skip login: use this token directly |
| `FREEBUFF_PROXY_KEY` | — | Require `Authorization: Bearer <key>` on `/v1/*` and `/api/*` for **non-loopback** peers (the local UI and desktop shell are exempt; set this before binding to anything but `127.0.0.1`) |
| `FREEBUFF_MOCK` | off | Use the in-process mock backend |
| `FREEBUFF_MOCK_CHAOS` | off | Mock: reject the first chat call (tests gate re-admission) |

The daemon also picks up existing credentials from the official CLI's
`~/.config/manicode/credentials.json` (read-only) if you've already logged in
there. Its own state lives in `~/.config/freebuff-adapter/state.json` (mode
0600); a pre-rename state file at `~/.config/freebuff-port/state.json` is
picked up as a one-time fallback so upgrading doesn't log you out.

## HTTP surface

**UI + admin (browser)**
- `GET /` — the monochrome dark UI (ad viewer, console, chat test)
- `GET /api/state` — full state snapshot (user, session, ads, logs, tasks…)
- `GET /api/events` — SSE stream of every log/report/task/ad/state change
- `POST /api/login` · `/api/login/cancel` · `/api/logout`
- `POST /api/session/admit` `{model}` · `/api/session/release`
- `POST /api/settings` `{model, adsEnabled, autoAdmit, adIntervalMs}`
- `POST /api/ads/refresh` · `/api/ads/click` `{impUrl}`
- `POST /api/streak/check` — force a streak check-in now (bypasses the once-per-Pacific-day gate)
- `POST /api/shutdown` — graceful stop (releases the session); used by the desktop shell
- `GET /healthz`

**OpenAI-compatible**
- `GET /v1/models` — Freebuff model catalog
- `POST /v1/chat/completions` — proxy; streaming (`stream: true`) and
  non-streaming. Injects `Authorization`, the `Freebuff-CLI/<ver>` user-agent
  (free-mode chat is gated on it), and the Freebuff gate identity: a top-level `codebuff_metadata` block
  (`freebuff_instance_id`, `run_id` from a freshly started
  `POST /api/v1/agent-runs` run, `client_id`, `cost_mode: "free"`) plus the
  legacy `providerOptions.codebuff.codebuff_metadata` shape. Reserved keys are
  spread last so callers can't override them, mirroring the official SDK.

**Anthropic Messages API** (for Claude Code / Anthropic SDKs)
- `POST /v1/messages` (alias `/messages`) — converts Anthropic requests to
  the OpenAI shape above and converts the response back: Anthropic SSE events
  (`message_start` / `content_block_*` / `message_delta` / `message_stop`),
  `tool_use` blocks with `input_json_delta`, and non-streaming messages.
  System prompts, tool definitions, `tool_result`/`tool_use` history, images
  (base64) and `stop_sequences` all map across. Unknown model names (Claude
  Code sends its own) fall back to the configured default with a warning.
- `POST /v1/messages/count_tokens` (alias `/messages/count_tokens`) —
  heuristic `input_tokens` estimate (~4 chars/token).

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://127.0.0.1:8899 \
ANTHROPIC_AUTH_TOKEN=anything-or-your-FREEBUFF_PROXY_KEY \
ANTHROPIC_MODEL=deepseek/deepseek-v4-pro \
  claude
```

## Session lifecycle

- **Admission** — `POST` with `x-freebuff-model: <model>`; the daemon keeps
  the returned `instanceId`.
- **Polling** — `GET` every 30 s with `x-freebuff-instance-id` to catch
  expiry / supersede / quota exhaustion.
- **Gate handling** — if the chat upstream answers `428 waiting_room_required`,
  `410 session_expired`, or the session-bound `409`s, the daemon releases and
  re-admits the session, then retries the request once. Everything is reported
  to the UI (warning + `gate_rejection` report).
- **Model switch** — `DELETE` then `POST`, like the official client.
- **Release** — `DELETE` on logout and on daemon shutdown (SIGINT/SIGTERM).

## Ad cadence (matches the official client)

- Fetch via `POST /api/v1/ads` (browser-like `userAgent`, recent conversation
  messages for targeting). The daemon tries provider/surface candidates in
  order (`gravity/cli_chat` → `gravity/waiting_room` → `carbon/waiting_room` →
  `carbon/cli_chat`) until one returns inventory — on the live backend gravity
  can come back empty while carbon has ads.
- Rotate every 60 s; cache up to 50 sets; fall back to cached ads on failure.
- Report `POST /api/v1/ads/impression` **once per ad shown** with
  `mode: "LITE"` (Freebuff mode → no credits; ad viewing funds the sessions).
  ZeroClick ads report to `zeroclick.dev` first.
- Clicking an ad in the UI reports `POST /api/v1/ads/click` and opens the URL.

## Models

`deepseek/deepseek-v4-pro` (default) · `deepseek/deepseek-v4-flash` ·
`openai/gpt-5.6-luna` · `minimax/minimax-m3` · `mimo/mimo-v2.5` ·
`z-ai/glm-5.2` (referral/streak sessions only).

## Architecture

| File | Role |
| --- | --- |
| `src/index.js` | Entry point: config, wiring, banner, shutdown |
| `src/daemon.js` | Orchestration: login/session/ad loops, gate re-admission, chat injection |
| `src/server.js` | HTTP server: UI, state + SSE, admin API, `/v1/*` proxy |
| `src/freebuff.js` | Typed API client (retry/backoff, UA headers, typed session statuses) |
| `src/fingerprint.js` | Device fingerprint (`enhanced-` or `codebuff-cli-` fallback) |
| `src/store.js` | Persisted state + read-only official-credentials pickup |
| `src/bus.js` | Event bus: ring-buffered logs/errors/warnings/reports + tasks |
| `src/models.js` | Model catalog |
| `src/mock.js` | In-process mock backend for offline testing |
| `src/anthropic.js` | Anthropic Messages API ↔ OpenAI conversion (request, response, SSE, tokens) |
| `test/anthropic.test.js` | `node:test` unit tests for the conversion layer (`npm test`) |
| `ui/index.html` | Monochrome dark UI (zero-dependency, plain JS + SSE) |
| `desktop/main.js` | Electron shell: auto-starts the daemon and opens the UI window |

## Caveats

- The daemon binds to `127.0.0.1` only. Use `FREEBUFF_PROXY_KEY` before
  exposing it anywhere else.
- Auto-admit adopts whatever active session exists for the account (including
  one held by another client — the server marks it `superseded`).
- Freebuff's server fingerprints clients by request shape; a third-party
  client may be capped at the `verified` trust tier, and accounts that abuse
  quotas/country gates get actioned. This port follows the official wire
  contract but is not an official client — see `findings/05-porting-guide.md`
  and review freebuff.com's terms before using it.
- **Live backend (observed 2026-08-17):** the chat gate requires a server-side
  run (`POST /api/v1/agent-runs` → top-level `codebuff_metadata.run_id`) and
  a first system message opening with the canonical freebuff root prompt
  (`You are Buffy, the coding agent behind Codebuff.` — byte-exact prefix
  test). The port satisfies both: it starts the run and injects the canonical
  prompt as `messages[0]` before forwarding (`src/freebuff-prompt.js`). If the
  server adds a stricter check later, the daemon reports `chat_cli_required`
  in the UI instead of failing silently.
