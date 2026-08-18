# Porting Guide — running the Freebuff flow outside the official client

Freebuff grants free model access through the official CLI. A third-party port
(the approach this repo takes) reproduces the wire contract and runs the same
flow locally. This documents what that means in practice.

## Trust tier

Freebuff's server fingerprints clients by request shape. A client that follows
the wire contract but is not the official binary sits at the `verified` trust
tier. That is generally enough to get sessions, ads, and chat — but:

- Terms enforcement (quota abuse, country gates) is server-side and can change
  without notice.
- New gate signals (a stricter system-prompt check, a new metadata field) can
  break a port while the official client keeps working.
- Accounts that trip server heuristics get actioned; the port is not an
  official client and provides no recourse.

Review freebuff.com's terms before relying on this for anything you can't
afford to lose.

## What the port must get right (observed on the live backend, 2026-08)

1. **Run id** — the chat gate requires `codebuff_metadata.run_id` from a
   server-side `POST /api/v1/agent-runs`. A locally-generated id is rejected.
2. **Canonical system prompt** — `messages[0]` must open byte-exact with a
   canonical freebuff root prompt (`You are Buffy, the coding agent behind
   Codebuff.` for base3-free roots). The daemon injects it when the caller's
   messages don't qualify (`src/freebuff-prompt.js`).
3. **Instance id** — `codebuff_metadata.freebuff_instance_id` must match the
   live session's instanceId.
4. **Session lifecycle** — admit (POST with `x-freebuff-model`), poll every
   30 s, release on shutdown (DELETE). Model switch = DELETE then POST.
5. **Impressions** — one `POST /api/v1/ads/impression` per ad *shown*
   (deduped by `impUrl`, capped to the displayed batch), `mode: "LITE"`.

## Failure surface

When the server tightens a gate, the daemon surfaces it instead of failing
silently: `chat_cli_required` / `gate_rejection` reports land in the UI's
console. If a new check appears, look for 403s with `free_mode_cli_required`
in the reports tab and re-check the constants in `src/freebuff-prompt.js`.

## Staying honest

- Impressions are reported only for ads actually rendered (`MAX_AD_VIEW` cap),
  so "shown" and "impressions" stay consistent.
- The impression dedupe set is in-memory — a daemon restart can re-report ads
  the server already saw. The server is presumed to dedupe on its side.
- Streak check-in is one authed GET per Pacific day, mirrored from the official
  client; failures are reported but never fatal.
