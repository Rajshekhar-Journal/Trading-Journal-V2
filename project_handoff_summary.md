# Advanced Trading Journal — Project Handoff & Status Report
**Date:** 2026-06-30

This document provides a comprehensive summary of the Advanced Trading Journal project. It is designed to get another AI (like Claude) fully up to speed on the architecture, current state, and immediate next steps.

---

## 1. Project Overview & Architecture
The project is a professional-grade Trading Journal built as a client-side web application.
- **Tech Stack:** Vanilla HTML, CSS, JavaScript. Chart.js for charts, Lucide for icons.
- **Data Layer:** Currently uses `localStorage` (via `js/db.js`). Phase 2 will migrate this to a real database (e.g., Supabase/Firebase) with user authentication.
- **Architecture Principle:** "Single Trade Lifecycle". `db.js` acts as the Single Source of Truth. Trades are not duplicated across modules. A trade is `OPEN` if `openQty > 0` (shows in Positions) and `CLOSED` if `openQty === 0` (shows in Trades).
- **Calculations:** All financial math (R-multiples, expectancy, drawdown, portfolio heat) is pure and centralized in `js/calculations.js`.
- **UI Structure:** Modular Single Page Application (SPA). `index.html` contains the shells, `css/` has the styling, and `js/modules/` contains the view-controllers for each of the 7 modules.

## 2. Current State: Phase 1 Completed
The core framework for all 7 modules is fully built, functional, and seeded with data.
1. **Dashboard:** High-level overview, equity/P&L charts, current portfolio heat.
2. **Positions:** Open trade monitoring, quick actions (partial exit, final exit, pyramid, stop revision).
3. **Trades:** Closed trade history, metrics, and detailed lifecycle review.
4. **Playbook:** Setup library with versioning, rules, and linked trade analytics.
5. **Analytics:** Performance intelligence, trade analytics, risk analytics, discipline score, and a Growth Simulator.
6. **Capital:** Equity curve, deposit/withdrawal ledger, and available cash tracking.
7. **Settings:** General prefs, trading defaults, risk management, alert config, and data backup/restore.

## 3. Recent SRS Audit Findings
A comprehensive audit against the 7 Module SRS documents was just completed. While the app is highly functional, several gaps were identified that need fixing to achieve 100% SRS compliance:
- **Critical Gaps:**
  - **Trade Detail Panel:** Needs edit (✏) and delete (🗑) buttons for individual lifecycle records (entries, pyramids, exits) with auto-recalculation upon save.
  - **Dashboard:** Missing the "Remaining Capacity" card. Portfolio Heat format should be `1.85R / 4R`.
  - **Alerts Engine:** Day-5, Stop Breach, and ATR alerts are defined but the engine is not auto-running on page load.
  - **Capital:** Missing CAGR and Absolute Return % metrics.
  - **Playbook:** Missing sort functionality and a guard to ensure only one "Active" version exists at a time.

## 4. Immediate Backlog (User's Latest Requests)
The user provided a specific list of 12 enhancements right before this handoff. **Claude should start by addressing these:**

1. **Market Breadth:** Add a document link for Market Breadth definition and importance (likely in the Settings/Formula Manager or a modal).
2. **Dashboard Chart:** Change the Daily Net cumulative P&L chart to a line chart (currently uses a bar/line mix or similar, ensure it's a clean line chart).
3. **Positions Split View:** Increase the Trade Details panel width (approx. half the screen). Add a full-screen button/functionality to expand the Trade Detail table into full screen.
4. **Unrealized P&L (R Value):** In the Trade Detail table and Position table, Unrealized P&L must show the R value in brackets, e.g., `₹10,000 (+1.5R)`.
5. **Realized P&L Visibility:** Add Realized P&L to the Position Table, Trade Details cards, and Trade Lifecycle summary.
6. **TradingView Chart Fix:** The TradingView chart iframe in the trade details is not linked/rendering properly and needs the URL format corrected.
7. **Live CMP Update:** In the Trade Detail and Position tables, add a manual way (or a free Yahoo Finance API fetch button) to update the CMP (Current Market Price) easily.
8. **Lifecycle Editing (Critical):** Since Trade Detail is the single source of truth, users must have Edit/Delete options for user inputs (lifecycle entries). Editing must trigger recalculation of dependent data. *(Note: This aligns with the SRS audit gap).*
9. **Analytics Charts:** Rename "Cumulative Equity" chart in Analytics to "Cumulative P&L" (and same in Dashboard). Add a *second* chart option in Analytics for true "Cumulative Equity" (which includes account value, deposits, and withdrawals).
10. **Playbook Analytics Chart:** Add a new chart: "Playbook vs Avg Holding Days".
11. **Settings / Default RPT:** In the Trading Defaults section, the Default RPT should not be a static input but should be auto-populated/computed from the Risk Management section (based on Fixed or Dynamic risk settings).
12. **Capital Module Risk Config:** Remove the Risk per trade settings from the Capital Management module (it should only live in the Settings module).

## 5. Suggested Workflow for Claude
1. **Review Context:** Read `js/db.js`, `js/calculations.js`, and the specific module files (`js/modules/positions.js`, `js/modules/trades.js`, etc.) to understand the state flow.
2. **Tackle the Backlog:** The 12 items above are clearly defined. I highly recommend updating `positions.js`, `trades.js`, `capital.js`, and `analytics.js` to knock these out.
3. **Architecture Note on Editing:** For item #8 (Lifecycle Editing), ensure that when a lifecycle record (e.g., an entry or exit) is edited or deleted, the code calls `db.saveTrade(updatedTrade)`, then triggers a re-render of the module to force all `calc.js` metrics to update globally.

***

**System Note:** I attempted to spawn subagents to fix these items automatically, but we hit an API quota limit (`RESOURCE_EXHAUSTED`). The project is in a completely stable state, ready for Claude to pick up these final polish items.
