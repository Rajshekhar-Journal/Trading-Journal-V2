# Deploy — Step 1 (security fixes) and Step 2 (backend rule runner)

Do these in order. Total time: about 30 minutes. Every command runs in **PowerShell** in the project folder:

```powershell
cd "C:\Users\khanr\OneDrive\Desktop\Project Trading Journal V2"
```

## 0. One-time: connect the Supabase CLI

The CLI is already installed in the project (`node_modules`), so use it through `npx`:

```powershell
npx supabase login                                        # opens the browser; approve
npx supabase link --project-ref zopskuwqlbteyiypwnid
```

## 1. Revoke the old GitHub tokens

Four local scripts (`push.mjs`, `deploy-v2.ps1`, `push-to-github.ps1`, `_archive/repair_trades.mjs`) contained GitHub tokens. They are removed from the files now, but anything ever pushed stays in git history, so:

1. GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic)** → delete every old token.
2. Keep (or create) one **fine-grained** token for pushing: repository *Trading-Journal-V2*, permission **Contents: Read and write**. Add **Workflows: Read and write** only if you want the CI file (step 3).

## 2. Self-host the browser libraries (no CDN at runtime)

```powershell
node scripts/vendor-libs.mjs
```

Expect three `✓` lines (supabase-js, chart.js, lightweight-charts) and two `now loads the local copies` lines. The files land in `js/vendor/`.

## 3. Publish the app

```powershell
$env:GITHUB_TOKEN = "<your fine-grained token>"
node push-tlm-v3.mjs              # or: node push-tlm-v3.mjs --with-ci   (adds the GitHub Actions test run)
```

The new app also works with the old Edge Functions, so publishing first avoids any gap.

## 4. Telegram bot token → server secret

The token used to sit in the database, readable from the browser. Recommended: issue a new one — in Telegram open **@BotFather**, send `/revoke`, pick your bot, copy the new token. Then:

```powershell
npx supabase secrets set TELEGRAM_BOT_TOKEN=<bot token>
```

## 5. Cron secret (lets only pg_cron start the scheduled run)

```powershell
$s = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'); $s
npx supabase secrets set CRON_SECRET=$s
```

Copy the printed value, then in **Supabase → SQL Editor** run (same value):

```sql
select vault.create_secret('<the printed value>', 'tlm_cron_secret');
```

To change it later: `select vault.update_secret((select id from vault.secrets where name = 'tlm_cron_secret'), '<new value>');` and set `CRON_SECRET` again.

## 6. Deploy the Edge Functions

```powershell
npm run deploy:functions
```

This copies the engine files into the function bundle, then deploys `tlm-runner` and `yahoo-finance`. Both check the caller themselves, so they are deployed with `--no-verify-jwt`.

## 7. Run migration 006

**Supabase → SQL Editor** → paste `supabase/migrations/006_backend_runner.sql` → **Run**. It creates the runner heartbeat and lock, removes the stored bot token from settings, and schedules the runner every minute, 08:30–16:29 IST, Monday–Friday.

## 8. Check it works

| Where | What you should see |
| --- | --- |
| SQL: `select last_finished_at, last_result from runner_status;` | `last_finished_at` moves every minute, Mon–Fri 08:30–16:29 IST. `ran: 0` outside 09:00–15:31 is normal. |
| SQL: `select status_code, content from net._http_response order by created desc limit 5;` | `200`. A `403` means `CRON_SECRET` and the Vault value differ (step 5). |
| App → Settings → Trade Lifecycle & Alerts | Bot token: **✅ Set on the server**. Enter your Chat ID → **📨 Send test message** → message arrives. |
| App → Dashboard → Alert Dashboard card | Green **● Server runner · hh:mm** during the scheduled hours. Orange **● Browser fallback** means no server heartbeat for 3 minutes (normal at weekends). |
| `npm test` | All tests pass. |

## 9. Turn off public sign-ups

Supabase → **Authentication → Sign In / Providers** → switch off **Allow new users to sign up**. Your own login keeps working.

## Rollback

- Pause the server runner: `select cron.unschedule('tlm-runner');` — an open app tab takes over within 3 minutes (dashboard alerts only, no Telegram). Re-run migration 006 to resume.
- Telegram is sent only by the server now; the browser never holds the bot token.

## What changed

| Area | Before | After |
| --- | --- | --- |
| GitHub tokens | Written in 4 scripts | Environment variable only; old scripts removed from the repo and git-ignored |
| `yahoo-finance` function | Open to anyone (no auth, any parameters) | Signed-in user only; ticker, range and interval validated |
| Vercel `/api/ohlc`, `/api/nse-price` | Open proxies | Removed; the trade chart uses the authenticated function |
| Browser libraries | CDN, `supabase-js@2` unpinned | Exact versions, self-hosted in `js/vendor/` (after step 2) |
| Telegram bot token | In the settings row, sent from the browser | Server secret; only the server runner sends |
| Rule engine | Browser tab, every 60 s while open | `tlm-runner` Edge Function every minute via pg_cron; browser shows status, falls back if the server is down |
| Double runs | Possible with two tabs open | One lock shared by browser and server (`runner_status`) |
| Tests | 24 | 27, plus an optional GitHub Actions run on every push |
