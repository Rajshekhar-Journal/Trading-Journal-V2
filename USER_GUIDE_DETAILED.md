# Advanced Trading Journal - Detailed User Guide

## Table of Contents
1. Introduction & Philosophy
2. Capital Management
3. Settings & Configuration
4. Playbook Management (Strategy Design)
5. Position Management (Trade Lifecycle)
6. Trade Review & Post-Analysis
7. Analytics & Business Intelligence
8. Core Concepts (R-Multiples, Portfolio Heat, Expectancy)

---

## 1. Introduction & Philosophy

The Advanced Trading Journal is built for systematic traders who treat trading as a business. Unlike standard journals that only track P&L, this application focuses on **process, discipline, and risk management**.

The core philosophy revolves around:
- **Thinking in R-Multiples:** Detaching from monetary values and evaluating risk/reward in standard units.
- **Playbook-Driven Trading:** Every trade must belong to a predefined strategy (Playbook).
- **Portfolio Heat Management:** Controlling overall exposure across all open positions.
- **Continuous Feedback:** Using the Analytics and Discipline modules to identify behavioral leaks and optimize edge.

---

## 2. Capital Management

Before you can trade, you must fund your virtual account.

### The Ledger
Navigate to the **Capital** module. This is your account ledger.
- **Deposits:** Adding fresh capital to your trading account. (Increases Equity & Available Cash)
- **Withdrawals:** Pulling profits or capital out. (Decreases Equity & Available Cash)
- **Adjustments:** Reconciling small differences (e.g., end-of-year interest, minor fee discrepancies).

### Adding Capital
1. Click **+ Add Transaction**.
2. Select the Transaction Type (Deposit).
3. Enter the Date and Amount.
4. Add any relevant remarks (e.g., "Initial 2026 funding").
5. Click **Add Transaction**. Your Account Value will immediately reflect this change.

---

## 3. Settings & Configuration

Proper configuration is crucial. Navigate to the **Settings** module.

### General & Trading Defaults
- Set your **Trader Name** and **Base Currency**.
- Define your **Default Trade Type** (Equity/Futures) to speed up data entry.

### Risk Management
This is the most critical setting.
- **Risk Mode:**
  - *Fixed Amount:* You risk a static amount per trade (e.g., ₹5000).
  - *Dynamic (% of Equity):* Your risk scales with your account size (e.g., 1% of current equity).
- **Max Portfolio Heat (R):** The absolute maximum total risk you are allowed to have open at any one time. If you risk 1R per trade and have a Max Heat of 4R, you can have a maximum of 4 full-risk positions open.
- **Warning Portfolio Heat (R):** Triggers a visual warning when you are approaching your maximum capacity.

### Charges & Brokerage
Accurate P&L requires accurate charge calculation.
- Select your **Broker** (default is Zerodha).
- The system pre-loads statutory charges (STT, Exchange, SEBI, GST, Stamp Duty).
- Ensure your specific **Brokerage** rates are entered correctly (e.g., ₹20 flat for Intraday/Futures, 0 for Equity Delivery).

---

## 4. Playbook Management (Strategy Design)

A Playbook is a detailed blueprint of a trading setup.

### Creating a Playbook
1. Go to the **Playbook** module and click **+ New Playbook**.
2. Provide a Name, Category, and Objective.
3. It starts as a **Draft**. Click the row to open the Detail Panel.

### Defining the Playbook Rules
- **Entry Rules:** Add specific, actionable rules (e.g., "Price must close above 50 SMA").
- **Exit Rules:** Toggle system exits like "Day-5 Time Exit" or "EMA20 Breakdown", or add custom exit rules.
- **Risk Rules:** Define the maximum initial risk and max pyramids allowed for this specific setup.
- **Checklist:** Create a pre-flight checklist you must mentally (or physically) check before taking the trade.

### Version Control & Publishing
- Playbooks have versions (e.g., v1.0).
- When a draft is ready, click **Publish**. It is now **Active** and can be assigned to trades.
- If you want to tweak an active playbook, click **Create New Version**. This creates a new draft (v1.1). Once published, the old version is archived. This ensures historical trades remain linked to the exact rules they were traded under.

---

## 5. Position Management (Trade Lifecycle)

The **Positions** module is your live dashboard for active trades.

### Logging a New Trade
1. Click **+ New Trade**.
2. Enter the Symbol (e.g., INFY).
3. Select the **Playbook**.
4. Enter Entry Date, Entry Price, Quantity, and your **Initial Stop Loss**.
5. The system calculates your **Risk Per Trade (RPT)**. If it exceeds your settings or violates your Portfolio Heat, it will warn you.
6. Click **Save Trade**.

### Quick Actions (Managing Open Trades)
Click on an open position to open the Detail Panel. You have four Quick Actions:
1. **Pyramid:** Adding to a winning position. The system recalculates your average entry price and total exposure.
2. **Revise Stop:** Trailing your stop loss. Enter the new stop and mark if it was a system trail or manual intervention. This locks in Open Risk (reduces Portfolio Heat) or locks in profit.
3. **Partial Exit:** Selling a fraction of your position. The system books partial P&L and updates the remaining open risk.
4. **Add Note:** Log psychological states or market observations.

### Alert Engine
The system runs checks against your open trades:
- If a position has been held for 5 days (and Day-5 exit is enabled), it raises a warning.
- If the CMP drops below your stop loss, it raises a critical alert.

---

## 6. Trade Review & Post-Analysis

When a trade is closed via **Final Exit**, it moves to the **Trades** module.

### Post-Trade Review
Your job is not done when the trade is closed.
1. Locate the closed trade in the Trades module and click it.
2. In the Overview tab, assign a **Star Rating (1-5)**. Rate your execution, *not* the financial outcome. A perfect loser (followed all rules) is a 5-star trade.
3. **Rule Monitoring:** Toggle the "Followed Rules" switch. If you broke a rule, mark it as broken.
4. Review the **Lifecycle Tab** to see a timeline of your entries, stop revisions, and exits.
5. Change the status to **Reviewed**.

---

## 7. Analytics & Business Intelligence

The **Analytics** module is your mirror.

- **Performance Dashboard:** View your overall Equity Curve, Drawdown depth, Monthly Heatmap, and Trading Score.
- **Trade Analytics:** Understand which sectors yield the best results, what days are best for entry, and view the distribution of your R-multiples (are your winners truly bigger than your losers?).
- **Playbook Analytics:** Directly compare your active strategies. Which playbook has the highest Expectancy? Which has the highest Win Rate?
- **Discipline:** Track your behavioral leaks. See how much money "Rule Broken" trades are costing you in total.
- **Growth Simulator:** Input your current Win Rate and Avg Win/Loss ratios. See projected account growth over 1, 3, 5, and 10 years based on compounding mathematics.

---

## 8. Core Concepts

### R-Multiples
'R' stands for Risk. If your stop loss dictates you will lose ₹5,000 on a trade, then ₹5,000 = 1R.
- If you make ₹15,000, you made +3R.
- If you lose ₹5,000, you lost -1R.
This allows you to compare trades across different stock prices and volatilities equally.

### Portfolio Heat
The sum total of your Open Risk.
- Trade A: Initial Risk ₹5000 (1R). Current Stop moved up, locking in risk to ₹2500 (0.5R).
- Trade B: Initial Risk ₹5000 (1R).
- **Total Portfolio Heat = 1.5R.**
Managing heat prevents catastrophic account blowouts during sudden market gaps.

### Expectancy
Expectancy answers: "On average, how much do I make per trade?"
Formula: `(Win Rate × Average Win R) - (Loss Rate × Average Loss R)`.
If your Expectancy is positive, you have a profitable edge. If it's negative, no amount of position sizing will save you.
