# Advanced Trading Journal - User Guide

Welcome to the Advanced Trading Journal! This guide will help you navigate the application and establish a professional workflow for managing your trades.

## 1. Getting Started

### Initial Login
1. Navigate to the application URL.
2. Log in using the email and password provided by your administrator.

### Setting Up Your Account
Before logging trades, configure your core settings:
1. Go to **Settings (⚙️)** in the navigation bar.
2. **General:** Set your Trader Name, Base Currency, and Timezone.
3. **Risk Management:** Define your Risk Mode.
   - **Fixed Amount:** E.g., ₹5000 risk per trade.
   - **Dynamic (% of Equity):** E.g., 1% of your total account equity per trade.
   - Set your **Max Portfolio Heat** (maximum total risk you are willing to take across all open positions, usually expressed in 'R', e.g., 4R).
4. **Charges & Brokerage:** Select your broker (e.g., Zerodha) and verify the brokerage charges to ensure accurate P&L calculations.

### Adding Initial Capital
1. Go to the **Capital** module.
2. Click **+ Add Transaction**.
3. Select **Deposit**, enter the date and amount of your starting capital.
4. Your Account Value and Available Cash will update immediately.

---

## 2. Creating Your Playbooks (Trading Strategies)

A "Playbook" defines the rules for a specific trading strategy. You must have at least one active Playbook to log a trade.

1. Go to the **Playbook** module.
2. Click **+ New Playbook**.
3. Enter a Name (e.g., "EMA Breakout"), Category, and Objective. This creates a "Draft" playbook.
4. Click on the newly created playbook to open its details.
5. Navigate through the tabs:
   - **Entry Rules:** Add specific conditions required to enter the trade.
   - **Exit Rules:** Configure system exits (e.g., Day-5 Exit, EMA20 close).
   - **Risk Rules:** Set maximum initial risk and portfolio heat guidelines.
   - **Checklist:** Create a pre-trade checklist.
6. Once configured, click **Publish** to make the Playbook "Active".

---

## 3. Logging and Managing Trades

### Opening a New Position
1. Go to the **Positions** module.
2. Click **+ New Trade**.
3. Fill in the details:
   - Symbol (e.g., RELIANCE)
   - Playbook (select the strategy you are using)
   - Entry Price, Quantity, and Initial Stop Loss.
4. The system will automatically calculate your Risk Per Trade (RPT) and position size. If it exceeds your settings, it will warn you.
5. Click **Save Trade**.

### Managing the Trade Lifecycle
Click on any open trade in the **Positions** module to open the Detail Panel.
Here you can execute "Quick Actions":
- **Pyramid:** Add to your winning position. Enter the new price and quantity.
- **Revise Stop:** Trail your stop loss upwards. Enter the new stop price and whether it was a manual or system-driven trail.
- **Partial Exit:** Sell a portion of your position to book profits.
- **Add Note:** Document your thoughts or market conditions during the trade.

*Note: All actions recalculate your open risk, exposure, and portfolio heat automatically.*

---

## 4. Closing a Trade and Reviewing

### Final Exit
1. In the **Positions** Detail Panel, click **Exit**.
2. Select **Final Exit**, enter the exit price and remaining quantity.
3. The trade will move from the Positions module to the **Trades** module.

### Post-Trade Review
1. Go to the **Trades** module.
2. Find your closed trade and click on it.
3. In the Overview tab:
   - **Rate the trade:** Give it a 1-5 star rating based on execution, not outcome.
   - **Rule Tracking:** Check off whether you followed all playbook rules. If you broke a rule, mark it. This affects your Discipline Score.
   - Change the Review Status from "Pending" to "Reviewed".

---

## 5. Analyzing Performance

### Analytics Dashboard
The **Analytics** module provides deep insights into your trading business.
- **Performance Tab:** View your overall Equity Curve, Drawdown Curve, and Monthly P&L heatmap.
- **Trade Analytics:** See performance broken down by sector, weekday, and holding period.
- **Playbook Analytics:** Compare the Expectancy and Win Rate of different strategies. Identify which playbooks make you money and which need adjustment.
- **Risk Analytics:** Monitor your historical portfolio heat and position sizing consistency.
- **Discipline:** Track your behavioral metrics. See how much money rule-breaking is costing you.

### Growth Simulator
Use the Growth Simulator tab to set target performance metrics (Win Rate, Average Win/Loss) and see projected account growth over 1, 3, 5, and 10 years based on those inputs.

---

## Key Terms

- **RPT (Risk Per Trade):** The monetary amount you plan to lose if your initial stop loss is hit.
- **R (Reward/Risk Multiple):** A standard unit of risk. If you risk ₹5000 on a trade (1R), and make ₹10000, your profit is +2R.
- **Portfolio Heat:** The sum total of 'Open Risk R' across all your active positions. If you have 3 trades, each risking 1R, your Portfolio Heat is 3R.
- **Expectancy:** The average amount you expect to win (or lose) per trade over the long run, measured in R.

---
*Happy Trading! Keep your losses small, follow your rules, and let your edge play out.*
