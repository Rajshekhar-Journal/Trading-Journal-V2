/**
 * seed.js — Demo Data Generator
 * Realistic Indian market trading data for demonstration.
 * Run once on first load.
 */
const seeder = (() => {

  function run() {
    if (db.isSeeded()) return;
    _seedSettings();
    _seedCapital();
    _seedPlaybooks();
    _seedTrades();
    db.markSeeded();
    console.log('✅ Demo data seeded successfully');
  }

  function _seedSettings() {
    const s = db.getDefaultSettings();
    s.general.traderName = 'Trading AL';
    s.riskManagement.maxPortfolioHeat = 4;
    s.riskManagement.warningPortfolioHeat = 3.5;
    s.riskManagement.riskPercent = 1;
    s.riskManagement.riskMode = 'Dynamic';
    s.marketHealth = { trend: 'Uptrend', breadthValue: 1.82, breadthClassification: 'Strong', guidance: 'Breakouts Favoured', lastUpdated: '2026-06-28' };
    db.saveSettings(s);
  }

  function _seedCapital() {
    const txns = [
      { id: 'cap_001', date: '2026-01-02', type: 'Deposit', amount: 1000000, account: 'Zerodha', remarks: 'Initial capital deposit' },
      { id: 'cap_002', date: '2026-02-03', type: 'Deposit', amount: 200000, account: 'Zerodha', remarks: 'Additional capital' },
      { id: 'cap_003', date: '2026-04-10', type: 'Withdrawal', amount: 50000, account: 'Zerodha', remarks: 'Personal withdrawal' },
      { id: 'cap_004', date: '2026-05-01', type: 'Deposit', amount: 150000, account: 'Zerodha', remarks: 'Capital top-up' },
    ];
    txns.forEach(t => db.saveCapitalTransaction(t));
  }

  function _seedPlaybooks() {
    const playbooks = [
      {
        id: 'pb_001', name: 'Stage 2 Breakout', currentVersion: '1.2', status: 'Active', category: 'Momentum',
        createdAt: '2026-01-01',
        versions: [{
          version: '1.2', status: 'Active', createdAt: '2026-02-01',
          objective: 'Capture momentum as stock breaks out of a long consolidation base into Stage 2 uptrend.',
          description: 'Enter stocks that are breaking out of a flat base on above-average volume after a period of Stage 1 base building. The stock should be a sector leader with strong relative strength.',
          marketType: 'Trending Bull Market', suitableTrend: 'Uptrend', riskCategory: 'Medium', idealHoldingPeriod: '20-60 days',
          entryRules: ['Stock must be in Stage 2 uptrend', 'Breakout on 2x+ average volume', 'RS Line at new highs', 'Price above all major MAs'],
          exitRules: { day5Rule: true, atrExtension: true, ema20Exit: true, customRules: ['Exit if weekly closes below EMA10'] },
          riskRules: { maxInitialRisk: 1, maxPyramid: 2, portfolioHeatGuideline: 4 },
          checklist: ['RS Line making new highs?', 'Volume on breakout 2x+ avg?', 'Proper base depth < 30%?', 'Market in confirmed uptrend?'],
          improvements: 'Added volume filter in v1.2 to reduce false breakouts.'
        }, {
          version: '1.1', status: 'Archived', createdAt: '2026-01-15',
          objective: 'Original Stage 2 breakout setup without volume filter.',
          description: 'Enter on breakout of flat base. No volume filter.',
          marketType: 'Trending', suitableTrend: 'Uptrend', riskCategory: 'Medium', idealHoldingPeriod: '20-60 days',
          entryRules: ['Stage 2 uptrend', 'Base breakout'],
          exitRules: { day5Rule: true, atrExtension: false, ema20Exit: true, customRules: [] },
          riskRules: { maxInitialRisk: 1, maxPyramid: 1, portfolioHeatGuideline: 4 },
          checklist: ['In Stage 2?', 'Breaking base?'],
          improvements: ''
        }]
      },
      {
        id: 'pb_002', name: 'EMA20 Pullback', currentVersion: '1.1', status: 'Active', category: 'Trend Following',
        createdAt: '2026-01-05',
        versions: [{
          version: '1.1', status: 'Active', createdAt: '2026-01-20',
          objective: 'Buy dips to EMA20 in a strong uptrending stock to add with lower risk.',
          description: 'In a confirmed Stage 2 uptrend, buy when price pulls back to and finds support at the EMA20 on low volume. Enter on the day price bounces off EMA20 with increased volume.',
          marketType: 'Trending', suitableTrend: 'Uptrend', riskCategory: 'Low-Medium', idealHoldingPeriod: '15-40 days',
          entryRules: ['Stock in Stage 2 uptrend', 'Pullback to EMA20 on low volume', 'Bounce on EMA20 with increased volume', 'Stop below recent low'],
          exitRules: { day5Rule: true, atrExtension: true, ema20Exit: true, customRules: [] },
          riskRules: { maxInitialRisk: 0.75, maxPyramid: 1, portfolioHeatGuideline: 3.5 },
          checklist: ['EMA20 tested on low volume?', 'Clear bounce signal?', 'Sector still strong?'],
          improvements: 'Added sector strength filter.'
        }]
      },
      {
        id: 'pb_003', name: 'Gap and Go Momentum', currentVersion: '1.0', status: 'Active', category: 'Momentum',
        createdAt: '2026-01-10',
        versions: [{
          version: '1.0', status: 'Active', createdAt: '2026-01-10',
          objective: 'Capture gap-up momentum from results or news catalysts in strong stocks.',
          description: 'Enter stocks gapping up on earnings/news catalyst on high volume. Stock must be a sector leader already in Stage 2. Wait for first 15-min candle to form, enter on breakout.',
          marketType: 'Any', suitableTrend: 'Uptrend or Sideways', riskCategory: 'High', idealHoldingPeriod: '5-20 days',
          entryRules: ['Gap up > 3% on catalyst', 'Strong volume (3x+)', 'Stock was already in Stage 2', 'Sector is leading'],
          exitRules: { day5Rule: true, atrExtension: true, ema20Exit: false, customRules: ['Quick partial at 1.5R'] },
          riskRules: { maxInitialRisk: 0.75, maxPyramid: 1, portfolioHeatGuideline: 3 },
          checklist: ['Valid catalyst?', 'Gap > 3%?', 'Volume 3x+?', 'Already in Stage 2?'],
          improvements: ''
        }]
      },
      {
        id: 'pb_004', name: 'Sector Leader Momentum', currentVersion: '1.0', status: 'Active', category: 'Momentum',
        createdAt: '2026-01-12',
        versions: [{
          version: '1.0', status: 'Active', createdAt: '2026-01-12',
          objective: 'Trade the strongest stocks in the leading sector of the current market cycle.',
          description: 'Identify the leading sector, then buy the top 1-2 stocks in that sector when they break out of a proper base. Rotate as leadership shifts.',
          marketType: 'Bull Market', suitableTrend: 'Uptrend', riskCategory: 'Medium', idealHoldingPeriod: '25-60 days',
          entryRules: ['Sector is market leading (RS > market)', 'Stock is top 1-2 RS in sector', 'Breaking out of tight base', 'All MAs are rising and in order'],
          exitRules: { day5Rule: false, atrExtension: true, ema20Exit: true, customRules: [] },
          riskRules: { maxInitialRisk: 1, maxPyramid: 2, portfolioHeatGuideline: 4 },
          checklist: ['Leading sector?', 'Stock RS > sector RS?', 'Tight base?', 'MAs in order?'],
          improvements: ''
        }]
      },
      {
        id: 'pb_005', name: 'Mean Reversion', currentVersion: '1.0', status: 'Archived', category: 'Reversal',
        createdAt: '2026-01-03',
        versions: [{
          version: '1.0', status: 'Archived', createdAt: '2026-01-03',
          objective: 'Trade oversold bounces — ARCHIVED due to poor expectancy.',
          description: 'Buy extreme oversold conditions expecting a mean reversion. Archived due to inconsistent results.',
          marketType: 'Any', suitableTrend: 'Any', riskCategory: 'High', idealHoldingPeriod: '3-10 days',
          entryRules: ['RSI < 25', 'Price > 3 ATR below mean'],
          exitRules: { day5Rule: true, atrExtension: false, ema20Exit: false, customRules: [] },
          riskRules: { maxInitialRisk: 0.5, maxPyramid: 0, portfolioHeatGuideline: 2 },
          checklist: ['Extreme oversold?', 'Volume dry-up?'],
          improvements: 'Archived — negative expectancy over 20+ trades.'
        }]
      }
    ];
    playbooks.forEach(pb => db.savePlaybook(pb));
  }

  function _seedTrades() {
    // Closed trades — mix of wins and losses with realistic Indian stock data
    const closedTrades = [
      _trade('tr_001', 'RELIANCE', 'Energy', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-01-05', price: 2720, qty: 36, charges: 280 }], [],
        [{ date: '2026-01-05', oldStop: 0, newStop: 2640, actionSource: 'Manual' }],
        [], { date: '2026-02-01', price: 2960, qty: 36, charges: 310 }, 10800, true, 5, '★★★★'),

      _trade('tr_002', 'TCS', 'IT', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-01-08', price: 3820, qty: 25, charges: 420 }], [],
        [{ date: '2026-01-08', oldStop: 0, newStop: 3710, actionSource: 'Manual' }],
        [], { date: '2026-01-22', price: 3720, qty: 25, charges: 380 }, 10000, false, 3, '★★'),

      _trade('tr_003', 'INFY', 'IT', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-01-12', price: 1580, qty: 62, charges: 380 }], [],
        [{ date: '2026-01-12', oldStop: 0, newStop: 1530, actionSource: 'Manual' }],
        [], { date: '2026-02-14', price: 1790, qty: 62, charges: 410 }, 9800, true, 5, '★★★★★'),

      _trade('tr_004', 'HDFCBANK', 'Banking', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-01-15', price: 1690, qty: 58, charges: 360 }], [],
        [{ date: '2026-01-15', oldStop: 0, newStop: 1645, actionSource: 'Manual' }],
        [], { date: '2026-01-25', price: 1650, qty: 58, charges: 320 }, 10440, false, 3, '★★'),

      _trade('tr_005', 'BHARTIARTL', 'Telecom', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-01-18', price: 1720, qty: 57, charges: 350 }],
        [{ date: '2026-02-05', price: 1820, qty: 28, charges: 200, actionSource: 'Pyramid', notes: 'Strong momentum continuation' }],
        [{ date: '2026-01-18', oldStop: 0, newStop: 1670, actionSource: 'Manual' },
         { date: '2026-02-10', oldStop: 1670, newStop: 1760, actionSource: 'Trail' }],
        [{ date: '2026-02-20', price: 1910, qty: 42, charges: 280, actionSource: 'Partial Exit', notes: 'Day-5 partial exit at ATR ext' }],
        { date: '2026-03-05', price: 1985, qty: 43, charges: 295 }, 10800, true, 5, '★★★★★'),

      _trade('tr_006', 'BAJFINANCE', 'NBFC', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-01-22', price: 7050, qty: 14, charges: 380 }], [],
        [{ date: '2026-01-22', oldStop: 0, newStop: 6840, actionSource: 'Manual' }],
        [], { date: '2026-02-03', price: 6850, qty: 14, charges: 290 }, 10500, false, 3, '★★★'),

      _trade('tr_007', 'TITAN', 'Consumer', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-01-28', price: 3380, qty: 29, charges: 350 }], [],
        [{ date: '2026-01-28', oldStop: 0, newStop: 3270, actionSource: 'Manual' }],
        [], { date: '2026-03-12', price: 3780, qty: 29, charges: 380 }, 9800, true, 5, '★★★★'),

      _trade('tr_008', 'WIPRO', 'IT', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-02-04', price: 580, qty: 170, charges: 360 }], [],
        [{ date: '2026-02-04', oldStop: 0, newStop: 562, actionSource: 'Manual' }],
        [], { date: '2026-02-15', price: 563, qty: 170, charges: 310 }, 10440, false, 3, '★'),

      _trade('tr_009', 'AXISBANK', 'Banking', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-02-08', price: 1120, qty: 89, charges: 370 }], [],
        [{ date: '2026-02-08', oldStop: 0, newStop: 1085, actionSource: 'Manual' }],
        [], { date: '2026-03-01', price: 1285, qty: 89, charges: 420 }, 10080, true, 5, '★★★★'),

      _trade('tr_010', 'SUNPHARMA', 'Pharma', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-02-10', price: 1640, qty: 60, charges: 360 }],
        [{ date: '2026-02-25', price: 1710, qty: 30, charges: 180, actionSource: 'Pyramid', notes: 'Adding on strength' }],
        [{ date: '2026-02-10', oldStop: 0, newStop: 1590, actionSource: 'Manual' },
         { date: '2026-03-05', oldStop: 1590, newStop: 1660, actionSource: 'Trail' }],
        [], { date: '2026-03-25', price: 1880, qty: 90, charges: 520 }, 10800, true, 5, '★★★★★'),

      _trade('tr_011', 'KOTAKBANK', 'Banking', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-02-14', price: 1950, qty: 50, charges: 360 }], [],
        [{ date: '2026-02-14', oldStop: 0, newStop: 1895, actionSource: 'Manual' }],
        [], { date: '2026-02-25', price: 1896, qty: 50, charges: 310 }, 10500, false, 3, '★★'),

      _trade('tr_012', 'PIDILITIND', 'Chemicals', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-02-18', price: 2720, qty: 36, charges: 350 }], [],
        [{ date: '2026-02-18', oldStop: 0, newStop: 2638, actionSource: 'Manual' }],
        [], { date: '2026-04-05', price: 3180, qty: 36, charges: 420 }, 10440, true, 5, '★★★★★'),

      _trade('tr_013', 'MARUTI', 'Auto', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-02-22', price: 11800, qty: 8, charges: 340 }], [],
        [{ date: '2026-02-22', oldStop: 0, newStop: 11440, actionSource: 'Manual' }],
        [], { date: '2026-03-08', price: 11450, qty: 8, charges: 290 }, 11200, false, 3, '★★'),

      _trade('tr_014', 'ICICIBANK', 'Banking', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-03-01', price: 1170, qty: 85, charges: 380 }],
        [{ date: '2026-03-15', price: 1230, qty: 42, charges: 200, actionSource: 'Pyramid', notes: 'Momentum continuation' }],
        [{ date: '2026-03-01', oldStop: 0, newStop: 1135, actionSource: 'Manual' },
         { date: '2026-03-20', oldStop: 1135, newStop: 1190, actionSource: 'Trail' }],
        [{ date: '2026-04-01', price: 1310, qty: 63, charges: 310, actionSource: 'Partial', notes: 'Partial at 3R' }],
        { date: '2026-04-20', price: 1380, qty: 64, charges: 330 }, 10800, true, 5, '★★★★'),

      _trade('tr_015', 'HINDUNILVR', 'FMCG', 'Equity', 'Long', 'pb_003', '1.0',
        [{ date: '2026-03-05', price: 2540, qty: 39, charges: 360 }], [],
        [{ date: '2026-03-05', oldStop: 0, newStop: 2465, actionSource: 'Manual' }],
        [], { date: '2026-03-18', price: 2466, qty: 39, charges: 295 }, 10530, false, 3, '★★'),

      _trade('tr_016', 'NESTLEIND', 'FMCG', 'Equity', 'Long', 'pb_003', '1.0',
        [{ date: '2026-03-10', price: 2340, qty: 42, charges: 350 }], [],
        [{ date: '2026-03-10', oldStop: 0, newStop: 2270, actionSource: 'Manual' }],
        [], { date: '2026-04-18', price: 2720, qty: 42, charges: 400 }, 9800, true, 5, '★★★★'),

      _trade('tr_017', 'LTIM', 'IT', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-03-15', price: 5320, qty: 18, charges: 360 }], [],
        [{ date: '2026-03-15', oldStop: 0, newStop: 5160, actionSource: 'Manual' }],
        [], { date: '2026-03-25', price: 5165, qty: 18, charges: 290 }, 10800, false, 3, '★'),

      _trade('tr_018', 'DIVISLAB', 'Pharma', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-03-18', price: 4380, qty: 22, charges: 350 }], [],
        [{ date: '2026-03-18', oldStop: 0, newStop: 4250, actionSource: 'Manual' }],
        [], { date: '2026-05-02', price: 5180, qty: 22, charges: 420 }, 10800, true, 5, '★★★★★'),

      _trade('tr_019', 'SBIN', 'Banking', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-03-22', price: 780, qty: 128, charges: 370 }], [],
        [{ date: '2026-03-22', oldStop: 0, newStop: 756, actionSource: 'Manual' }],
        [], { date: '2026-04-05', price: 757, qty: 128, charges: 290 }, 11520, false, 3, '★★'),

      _trade('tr_020', 'ASIANPAINT', 'Chemicals', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-04-02', price: 2680, qty: 37, charges: 360 }], [],
        [{ date: '2026-04-02', oldStop: 0, newStop: 2597, actionSource: 'Manual' }],
        [], { date: '2026-05-18', price: 3120, qty: 37, charges: 430 }, 10360, true, 5, '★★★★'),

      _trade('tr_021', 'HCLTECH', 'IT', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-04-08', price: 1720, qty: 58, charges: 360 }], [],
        [{ date: '2026-04-08', oldStop: 0, newStop: 1668, actionSource: 'Manual' }],
        [], { date: '2026-04-18', price: 1669, qty: 58, charges: 290 }, 10440, false, 3, '★★'),

      _trade('tr_022', 'RELIANCE', 'Energy', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-04-12', price: 2890, qty: 34, charges: 370 }],
        [{ date: '2026-04-28', price: 3020, qty: 17, charges: 190, actionSource: 'Pyramid', notes: 'Adding after consolidation' }],
        [{ date: '2026-04-12', oldStop: 0, newStop: 2800, actionSource: 'Manual' },
         { date: '2026-05-05', oldStop: 2800, newStop: 2920, actionSource: 'Trail' }],
        [{ date: '2026-05-15', price: 3150, qty: 25, charges: 280, actionSource: 'Partial', notes: '3R partial' }],
        { date: '2026-05-28', price: 3280, qty: 26, charges: 310 }, 10200, true, 5, '★★★★★'),

      _trade('tr_023', 'ULTRACEMCO', 'Cement', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-04-15', price: 10800, qty: 9, charges: 360 }], [],
        [{ date: '2026-04-15', oldStop: 0, newStop: 10480, actionSource: 'Manual' }],
        [], { date: '2026-04-28', price: 10485, qty: 9, charges: 280 }, 10800, false, 3, '★★'),

      _trade('tr_024', 'TCS', 'IT', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-04-20', price: 3950, qty: 25, charges: 380 }], [],
        [{ date: '2026-04-20', oldStop: 0, newStop: 3830, actionSource: 'Manual' }],
        [], { date: '2026-06-01', price: 4480, qty: 25, charges: 430 }, 10000, true, 5, '★★★★'),

      _trade('tr_025', 'TITAN', 'Consumer', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-04-25', price: 3620, qty: 27, charges: 355 }], [],
        [{ date: '2026-04-25', oldStop: 0, newStop: 3514, actionSource: 'Manual' }],
        [], { date: '2026-05-08', price: 3515, qty: 27, charges: 280 }, 10530, false, 3, '★'),

      _trade('tr_026', 'BAJFINANCE', 'NBFC', 'Equity', 'Long', 'pb_003', '1.0',
        [{ date: '2026-04-28', price: 7350, qty: 13, charges: 350 }], [],
        [{ date: '2026-04-28', oldStop: 0, newStop: 7130, actionSource: 'Manual' }],
        [], { date: '2026-06-10', price: 8420, qty: 13, charges: 410 }, 10000, true, 5, '★★★★'),

      _trade('tr_027', 'INFY', 'IT', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-05-05', price: 1620, qty: 61, charges: 360 }],
        [{ date: '2026-05-20', price: 1690, qty: 30, charges: 180, actionSource: 'Pyramid', notes: 'EMA20 hold + pyramid' }],
        [{ date: '2026-05-05', oldStop: 0, newStop: 1572, actionSource: 'Manual' },
         { date: '2026-05-25', oldStop: 1572, newStop: 1640, actionSource: 'Trail' }],
        [{ date: '2026-06-05', price: 1810, qty: 45, charges: 290, actionSource: 'Partial', notes: 'Partial at 3.5R' }],
        { date: '2026-06-18', price: 1870, qty: 46, charges: 310 }, 10800, true, 5, '★★★★★'),

      _trade('tr_028', 'KOTAKBANK', 'Banking', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-05-10', price: 2050, qty: 48, charges: 360 }], [],
        [{ date: '2026-05-10', oldStop: 0, newStop: 1990, actionSource: 'Manual' }],
        [], { date: '2026-05-22', price: 1991, qty: 48, charges: 285 }, 10560, false, 3, '★★'),

      _trade('tr_029', 'BHARTIARTL', 'Telecom', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-05-14', price: 1890, qty: 52, charges: 360 }], [],
        [{ date: '2026-05-14', oldStop: 0, newStop: 1832, actionSource: 'Manual' }],
        [], { date: '2026-06-15', price: 2180, qty: 52, charges: 420 }, 10920, true, 5, '★★★★'),

      _trade('tr_030', 'SUNPHARMA', 'Pharma', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-05-18', price: 1780, qty: 56, charges: 360 }], [],
        [{ date: '2026-05-18', oldStop: 0, newStop: 1724, actionSource: 'Manual' }],
        [], { date: '2026-05-28', price: 1725, qty: 56, charges: 280 }, 10640, false, 3, '★'),

      _trade('tr_031', 'HDFCBANK', 'Banking', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-05-22', price: 1810, qty: 55, charges: 370 }], [],
        [{ date: '2026-05-22', oldStop: 0, newStop: 1755, actionSource: 'Manual' }],
        [], { date: '2026-06-20', price: 2090, qty: 55, charges: 430 }, 10450, true, 5, '★★★★'),

      _trade('tr_032', 'WIPRO', 'IT', 'Equity', 'Long', 'pb_003', '1.0',
        [{ date: '2026-05-28', price: 610, qty: 163, charges: 360 }], [],
        [{ date: '2026-05-28', oldStop: 0, newStop: 591, actionSource: 'Manual' }],
        [], { date: '2026-06-08', price: 592, qty: 163, charges: 280 }, 10897, false, 3, '★'),

      _trade('tr_033', 'PIDILITIND', 'Chemicals', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-06-02', price: 3050, qty: 32, charges: 360 }], [],
        [{ date: '2026-06-02', oldStop: 0, newStop: 2960, actionSource: 'Manual' }],
        [], { date: '2026-06-22', price: 3480, qty: 32, charges: 415 }, 10080, true, 5, '★★★★'),
    ];

    // Open positions (currently open trades)
    const openTrades = [
      _openTrade('tr_101', 'ICICIBANK', 'Banking', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-06-10', price: 1280, qty: 78, charges: 370 }], [],
        [{ date: '2026-06-10', oldStop: 0, newStop: 1241, actionSource: 'Manual' }], 10920, 1241, 1360),

      _openTrade('tr_102', 'AXISBANK', 'Banking', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-06-12', price: 1190, qty: 84, charges: 360 }], [],
        [{ date: '2026-06-12', oldStop: 0, newStop: 1155, actionSource: 'Manual' }], 10920, 1155, 1225),

      _openTrade('tr_103', 'MARUTI', 'Auto', 'Equity', 'Long', 'pb_002', '1.1',
        [{ date: '2026-06-15', price: 12200, qty: 8, charges: 360 }], [],
        [{ date: '2026-06-15', oldStop: 0, newStop: 11840, actionSource: 'Manual' }], 10080, 11840, 12680),

      _openTrade('tr_104', 'DIVISLAB', 'Pharma', 'Equity', 'Long', 'pb_004', '1.0',
        [{ date: '2026-06-18', price: 5100, qty: 20, charges: 360 }],
        [{ date: '2026-06-24', price: 5340, qty: 10, charges: 195, actionSource: 'Pyramid', notes: 'Momentum continuation' }],
        [{ date: '2026-06-18', oldStop: 0, newStop: 4950, actionSource: 'Manual' },
         { date: '2026-06-25', oldStop: 4950, newStop: 5120, actionSource: 'Trail' }], 10800, 5120, 5580),

      _openTrade('tr_105', 'LTIM', 'IT', 'Equity', 'Long', 'pb_001', '1.2',
        [{ date: '2026-06-22', price: 5680, qty: 18, charges: 380 }], [],
        [{ date: '2026-06-22', oldStop: 0, newStop: 5506, actionSource: 'Manual' }], 10080, 5506, 5890),
    ];

    [...closedTrades, ...openTrades].forEach(t => db.saveTrade(t));
  }

  function _trade(id, symbol, sector, tradeType, direction, playbookId, playbookVersion,
    entries, pyramids, stopRevisions, partialExits, finalExit, rpt, ruleFollowed, rating, ratingStr) {

    const stops = stopRevisions.map((s, i) => ({
      id: `sr_${id}_${i}`, date: s.date, oldStop: s.oldStop, newStop: s.newStop, actionSource: s.actionSource, notes: s.notes || ''
    }));
    const initialStop = stops.length > 0 ? stops[0].newStop : 0;
    const currentStop = stops.length > 0 ? stops[stops.length - 1].newStop : initialStop;

    return {
      id, symbol, sector, tradeType, direction, playbookId, playbookVersion,
      initialStop, currentStop, rpt,
      entries: entries.map((e, i) => ({ id: `en_${id}_${i}`, ...e })),
      pyramids: (pyramids || []).map((p, i) => ({ id: `py_${id}_${i}`, ...p })),
      stopRevisions: stops,
      partialExits: (partialExits || []).map((p, i) => ({ id: `pe_${id}_${i}`, ...p })),
      finalExit: finalExit ? { id: `fe_${id}`, ...finalExit } : null,
      notes: [],
      alerts: [],
      ruleFollowed, reviewStatus: 'Reviewed', rating,
      chartLink: `https://www.tradingview.com/chart/?symbol=NSE:${symbol}`,
      tags: [sector],
      cmp: finalExit ? finalExit.price : null,
      createdAt: entries[0].date,
      closedAt: finalExit ? finalExit.date : null
    };
  }

  function _openTrade(id, symbol, sector, tradeType, direction, playbookId, playbookVersion,
    entries, pyramids, stopRevisions, rpt, currentStop, cmp) {

    const stops = stopRevisions.map((s, i) => ({
      id: `sr_${id}_${i}`, date: s.date, oldStop: s.oldStop, newStop: s.newStop, actionSource: s.actionSource, notes: s.notes || ''
    }));
    const initialStop = stops.length > 0 ? stops[0].newStop : currentStop;

    return {
      id, symbol, sector, tradeType, direction, playbookId, playbookVersion,
      initialStop, currentStop, rpt,
      entries: entries.map((e, i) => ({ id: `en_${id}_${i}`, ...e })),
      pyramids: (pyramids || []).map((p, i) => ({ id: `py_${id}_${i}`, ...p })),
      stopRevisions: stops,
      partialExits: [],
      finalExit: null,
      notes: [],
      alerts: [],
      ruleFollowed: true, reviewStatus: 'Pending', rating: 0,
      chartLink: `https://www.tradingview.com/chart/?symbol=NSE:${symbol}`,
      tags: [sector],
      cmp,
      createdAt: entries[0].date,
      closedAt: null
    };
  }

  return { run };
})();
