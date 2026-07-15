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
