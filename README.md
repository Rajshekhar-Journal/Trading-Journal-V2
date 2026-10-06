# Advanced Trading Journal

A professional, cloud-based trading journal designed for systematic traders to track positions, analyze performance, manage risk, and refine their trading edge.

## Features

- **Dashboard:** High-level overview of current business health, portfolio heat, open positions, and active alerts.
- **Positions Module:** Real-time monitoring of open trades, lifecycle management (pyramids, partial exits, stop revisions), and rule tracking.
- **Trades Module:** Detailed history of closed trades, performance metrics, and post-trade reviews.
- **Playbook Module:** A library for your trading setups. Define entry/exit rules, risk guidelines, and track the performance (Win Rate, Expectancy) of each strategy.
- **Analytics Module:** Deep dive into your performance with equity curves, drawdown charts, sector analysis, and a growth simulator.
- **Capital Management:** Ledger for deposits, withdrawals, and tracking account equity over time.
- **Settings & Config:** Customize risk models (Fixed vs Dynamic), brokerage charges, alerts, and application defaults.

## Technology Stack

- **Frontend:** HTML5, CSS3 (Vanilla), JavaScript (ES6+), Chart.js for data visualization.
- **Backend & Database:** Supabase (PostgreSQL) for cloud storage and Row Level Security (RLS).
- **Authentication:** Supabase Auth (Email/Password).
- **Hosting & API:** Vercel (Static hosting + Serverless functions for CORS-bypassing market data).

## Project Phases

- **Phase 1:** Core UI/UX and LocalStorage database (Completed).
- **Phase 2:** Cloud Migration (Supabase), Authentication, Async Architecture, Vercel Deployment (Completed).
- **Phase 3 (Upcoming):** Paid NSE live data integration, user registration, advanced AI insights, Excel/CSV exports.

## Setup & Deployment

This project is configured for automated deployment via Vercel.

1. **Supabase Setup:**
   - Create a new project on Supabase.
   - Run the SQL schema from `supabase/migrations/001_initial_schema.sql` in the SQL Editor.
   - Create users manually via the Authentication dashboard (Phase 2 uses admin-created accounts only).
   - Get your Project URL and Anon Key.

2. **Environment Variables (Local / Vercel):**
   - The application expects Supabase credentials to be configured in `js/db-cloud.js`. Ensure these are securely managed or injected via environment variables if upgrading the build process.

3. **Vercel Deployment:**
   - Connect this GitHub repository to Vercel.
   - Vercel will automatically deploy changes pushed to the `main` branch using the `vercel.json` configuration.

## Documentation

For instructions on how to use the application, please refer to the [User Guide](USER_GUIDE.md).

## Trade Lifecycle rule engine v3.0 (2026-09-28)

Real and paper trades follow one pre-defined rule set (spec: *Trade Lifecycle Rule Engine — Spec v3.0*).

| File | Role |
| --- | --- |
| `js/config.js` | Supabase URL / anon key — single source |
| `js/engine/indicators.js` | EMA (SMA-seeded), ATR, tick rounding, 5-min / 15-min hold checks, IST time helpers |
| `js/engine/tlm-rules.js` | Rule IDs LC-01…LC-10, stages, alert types, default parameters |
| `js/engine/tlm-engine.js` | Pure engine: `planPosition`, `createState`, `evaluateWatch`, `dayStart`, `evaluate` |
| `js/engine/market-data.js` | 1-min + daily candles; pluggable source (browser: `yahoo-finance` function, server: direct) |
| `js/engine/alert-service.js` | 3-line alerts, once-a-day / 1% / 15-min rules, pluggable notifier (Telegram on the server, real only), `alert_log` |
| `js/engine/executors.js` | Paper auto-execution (pyramids, stops, exits, charges) |
| `js/engine/runner.js` | One cycle; runs on the server (`tlm-runner`, every minute via pg_cron). The browser defers to it and falls back if its heartbeat is >3 min old |
| `js/modules/alert-dashboard.js` | Dashboard card + full-screen alert log |
| `js/modules/tlm-panel.js` | Lifecycle panel (stage, targets, hard stop, trails, entry-day charts) |

Database: run `supabase/migrations/004_paper_trades_watchlist.sql` and `005_tlm_engine.sql` in the Supabase SQL Editor.

Tests: `npm test` (pure engine, worked example and scenarios, Excel import, server runner).

## Backend rule runner + security (Steps 1–2, 2026-10-03)

- `supabase/functions/tlm-runner` runs the same engine files server-side (copied by `npm run sync-engine` into `supabase/functions/_shared/engine`; a test fails if they drift). pg_cron calls it every minute (migration `006_backend_runner.sql`); one lock in `runner_status` keeps browser and server from running together.
- Secrets live only in Supabase: `TELEGRAM_BOT_TOKEN`, `CRON_SECRET` (+ Vault `tlm_cron_secret`). No tokens in files; the push script reads `GITHUB_TOKEN` from the environment.
- Edge Functions accept only a signed-in user's token (`js/auth.js` attaches it); `yahoo-finance` validates ticker, range and interval.
- `node scripts/vendor-libs.mjs` self-hosts supabase-js, Chart.js and Lightweight Charts in `js/vendor/`.
- Deployment steps: `DEPLOY_STEP1_2.md`.

Retired code is in `_archive/`; the pre-v3.0 code is backed up in `_backup_pre_tlm_v3/`.

## Chartbook (v3.1, 2026-10-06)

- `js/engine/chartbook.js` decides which charts a trade needs — entry, each 1R add, and exit once fully closed — and builds them (daily candles, entry-day 1-min candles, levels, markers, stop-loss path). Charts taken during the session are provisional and are re-taken as final after the close. The server runner (`tlm-runner`) does this every minute; `chartbook-backfill` builds charts for older trades in batches.
- `js/modules/chart-render.js` draws them (20-day EMA, fill / stop / target lines, entry-add-exit markers) for the Trade lifecycle panel, the **Chartbook** page and export.
- `js/modules/chartbook.js` — Chartbook page: filters (real/paper, result, dates, playbook, R, symbol), notes & lessons, Build missing charts, Export PDF / Word (`js/export/*`, no third-party libraries).
- Database: run `supabase/migrations/007_chartbook.sql`.
