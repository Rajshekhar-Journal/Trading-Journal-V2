-- ============================================================
-- 008 — Re-take charts that are missing their own event-day candle
-- (charts taken early in the session from a daily series without the current day:
--  the entry marker then sat on the previous day's candle).
-- Marks them provisional; the server rule runner re-takes them on its next run.
-- Safe to run more than once.
-- ============================================================
UPDATE trade_snapshots
   SET final = FALSE
 WHERE entry_date IS NOT NULL
   AND NOT (daily @> jsonb_build_array(jsonb_build_object('date', to_char(entry_date, 'YYYY-MM-DD'))));

-- Check (should list the affected charts, then return 0 rows after the next market-hours run):
-- SELECT trade_id, kind, entry_date, final FROM trade_snapshots
--  WHERE NOT (daily @> jsonb_build_array(jsonb_build_object('date', to_char(entry_date, 'YYYY-MM-DD'))));
