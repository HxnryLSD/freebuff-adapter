# Freebuff API Reference (as implemented)

Wire contract the port talks to. Prod split: `freebuff.com` hosts only the
`/api/auth/cli/*` login endpoints; the API surface and chat-completions live on
`www.codebuff.com` (codebuff.com 307-redirects there). A single custom host
(tests, mock, self-hosted) serves everything from one origin.

## Login (auth surface, `FREEBUFF_BASE_URL`)

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/api/auth/cli/code` | POST | Body `{ fingerprintId }` → `{ loginUrl, fingerprintHash, expiresAt, expiresInMs }` |
| `/api/auth/cli/status` | GET | Query `fingerprintId`, `fingerprintHash`, `expiresAt`; empty body until signed in, then `{ user: {...authToken} }`; 401 → not yet |
| `/api/auth/cli/logout` | POST | Body `{ userId, fingerprintId, fingerprintHash }` |

## API surface (`FREEBUFF_APP_URL`, default `https://www.codebuff.com`)

All endpoints require `Authorization: Bearer <token>` unless noted.

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/api/v1/me?fields=id,email` | GET | Token validation. Only `id`, `email`, `discord_id`, `stripe_customer_id`, `banned`, `created_at` are valid fields — `name` 400s the request. |
| `/api/v1/freebuff/session` | GET/POST/DELETE | Session lifecycle. GET with `x-freebuff-instance-id` + `x-freebuff-compact-session: 1`; POST with `x-freebuff-model: <model>`; 404 → `none`; typed 403/409/429 gate statuses returned as body. |
| `/api/v1/agent-runs` | POST | `{ action: "START", agentId }` (+ `x-freebuff-acting-user-id`) → `{ runId }`. Required by the chat gate: `codebuff_metadata.run_id` must be a server-known run. |
| `/api/v1/freebuff/streak` | GET | → `{ streak: number }`. One authed GET per Pacific day is the whole check-in. |
| `/api/v1/ads` | POST | Body `{ provider, surface, messages, sessionId, device, userAgent }` → `{ provider, ads: AdResponse[] }`. |
| `/api/v1/ads/impression` | POST | `{ impUrl, mode: "LITE" }` → `{ creditsGranted }` (0 in LITE). One per ad shown. |
| `/api/v1/ads/click` | POST | `{ impUrl, surface? }`. |
| `/api/v1/chat/completions` | POST | OpenAI-compatible; on `FREEBUFF_CHAT_BASE_URL` (defaults to the app surface). |

## Ad shape (`AdResponse`)

The port's hard contract: `impUrl` (dedupe + impression/click key), `title`,
`adText`. Optional: `url` (destination; live carbon ads can omit it — the UI
hides the CTA then), `cta`, `favicon`, `clickUrl`, `provider`
(`gravity`/`carbon`/`zeroclick`), `impressionIds` (ZeroClick only — also
POSTed to `https://zeroclick.dev/api/v2/impressions` before the local report).

## Chat gate (free mode)

The server 403s free-mode chat (`free_mode_cli_required`) unless the request
carries all of:

1. `Authorization: Bearer <token>`
2. `codebuff_metadata.run_id` from a freshly started `/api/v1/agent-runs`
   (top-level body field; the nested `providerOptions.codebuff.codebuff_metadata`
   shape is also sent for legacy clients but no longer read)
3. `codebuff_metadata.freebuff_instance_id` = the live session's instanceId
4. `messages[0]` a system message opening byte-exact with a canonical freebuff
   root prompt (`You are Buffy, the coding agent behind Codebuff.` for
   base3-free roots — see `src/freebuff-prompt.js`)

Session-gate rejections: 428 `waiting_room_required`, 410 `session_expired`,
409 with `session_superseded` / `session_model_mismatch`. The daemon releases,
re-admits, and retries once.
