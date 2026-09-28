/**
 * engine/tlm-rules.js — Trade Lifecycle Management rule set v3.0.
 * Rule IDs, stages, alert types and default parameters. Data only.
 */
(function (root) {
  const RULES_VERSION = '3.0';

  const RULES = Object.freeze({
    ENTRY:        'LC-01',
    ADD_1R:       'LC-02',
    LOCK_2R:      'LC-03',
    BOOK_5R:      'LC-04',
    BOOK_10R:     'LC-05',
    TRAIL_UPDATE: 'LC-06',
    TRAIL_EXIT:   'LC-07',
    HARD_TRAIL:   'LC-08',
    HARD_EXIT:    'LC-09',
    DAY_BRIEF:    'LC-10',
  });

  /** Stages only move forward. */
  const STAGES = Object.freeze({ WATCHING: 0, ENTERED: 1, R1: 2, R2: 3, R5: 4, R10: 5 });
  const STAGE_LABELS = ['Watching', 'S1 Entered', 'S2 1R added', 'S3 2R locked', 'S4 5R trail', 'S5 10R trail'];

  const ALERT_TYPES = Object.freeze({
    [RULES.ENTRY]:        'Entry triggered',
    [RULES.ADD_1R]:       'Target reached — 1R',
    [RULES.LOCK_2R]:      'Target reached — 2R',
    [RULES.BOOK_5R]:      'Target reached — 5R',
    [RULES.BOOK_10R]:     'Target reached — 10R',
    [RULES.TRAIL_EXIT]:   'Partial exit',
    [RULES.HARD_EXIT]:    'Stop loss breached',
    [RULES.DAY_BRIEF]:    'Set stop loss (day start)',
  });

  const DEFAULT_PARAMS = Object.freeze({
    rulesVersion: RULES_VERSION,
    entryHoldMin: 5,          // LC-01: minutes price must hold above trigger
    targetHoldMin: 5,         // LC-02..05: minutes price must hold above a target
    trailHoldMin: 15,         // LC-07: minutes below trail before exit
    trailDeepBreakPct: 2,     // LC-07: exit at once when this % below the trail
    firstEntryPct: 50,        // % of full size bought at entry; the 1R add buys the same qty
    stopRaiseAt1R: 0.5,       // LC-02: stop raised by this many R
    emaPeriod: 20,
    emaBufferPct: 2,          // hard stop = EMA20 × (1 − 2%)
    tranche5Pct: 40,          // LC-04: % of open qty trailed at 5R
    tranche10Pct: 50,         // LC-05: % of open qty trailed at 10R
    largeCandleAtrMult: 2.5,  // LC-06: large candle = close-to-close move > 2.5 × ATR14
    atrPeriod: 14,
    briefMinute: 9 * 60,      // 09:00 IST day-start brief
    marketOpenMinute: 9 * 60 + 15,
    marketCloseMinute: 15 * 60 + 30,
    alertResendPct: 1,        // AL-02
    breachRepeatMin: 15,      // AL-05: repeat stop-breach alert on real trades
  });

  /** R multiples of the four targets. */
  const TARGET_R = Object.freeze({ T1: 1, T2: 2, T5: 5, T10: 10 });

  const api = { RULES_VERSION, RULES, STAGES, STAGE_LABELS, ALERT_TYPES, DEFAULT_PARAMS, TARGET_R };
  root.TLMRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
