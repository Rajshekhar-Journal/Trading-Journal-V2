-- ============================================================
-- Trading Journal — Migration 005: Trade Lifecycle rule engine v3.0
-- Adds alert_log (Alert Dashboard + Telegram history), trade_snapshots
-- (entry-day charts) and a mode on watchlist items.
-- Safe to re-run. Run in Supabase SQL Editor AFTER 004.
-- ============================================================

-- ── ALERT LOG ──
CREATE TABLE IF NOT EXISTS alert_log (
  id               TEXT PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trade_id         TEXT,                 -- trades.id or paper_trades.id (null for watchlist entry alerts)
  watchlist_id     TEXT,
  mode             TEXT NOT NULL CHECK (mode IN ('real','paper')),
  symbol           TEXT NOT NULL,
  rule_id          TEXT NOT NULL,        -- LC-01 .. LC-10
  alert_type       TEXT NOT NULL,
  stage            INTEGER,
  cmp              NUMERIC,
  suggestion       JSONB DEFAULT '{}'::JSONB,   -- { kind, qty, stop, trail, price }
  message          TEXT,
  status           TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Executed','Dismissed')),
  telegram_status  TEXT,                 -- sent | failed | skipped
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  executed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS alert_log_user_time_idx ON alert_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS alert_log_trade_idx     ON alert_log (trade_id, rule_id);

ALTER TABLE alert_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own alerts"   ON alert_log;
DROP POLICY IF EXISTS "Users can insert own alerts" ON alert_log;
DROP POLICY IF EXISTS "Users can update own alerts" ON alert_log;
DROP POLICY IF EXISTS "Users can delete own alerts" ON alert_log;
CREATE POLICY "Users can view own alerts"   ON alert_log FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own alerts" ON alert_log FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own alerts" ON alert_log FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own alerts" ON alert_log FOR DELETE USING (auth.uid() = user_id);

-- ── TRADE SNAPSHOTS (entry-day chart data) ──
CREATE TABLE IF NOT EXISTS trade_snapshots (
  id          TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trade_id    TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('real','paper')),
  rule_id     TEXT,                      -- LC-01 entry or LC-02 1R add
  entry_ref   TEXT,                      -- id of the entry / pyramid record
  entry_date  DATE,
  taken_at    TIMESTAMPTZ DEFAULT NOW(),
  daily       JSONB DEFAULT '[]'::JSONB, -- ~120 daily candles up to the entry day
  intraday    JSONB DEFAULT '[]'::JSONB, -- 1-min candles of the entry day (when taken same day)
  levels      JSONB DEFAULT '{}'::JSONB  -- trigger, stop, targets, fill price
);
CREATE INDEX IF NOT EXISTS trade_snapshots_trade_idx ON trade_snapshots (trade_id);

ALTER TABLE trade_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own snapshots"   ON trade_snapshots;
DROP POLICY IF EXISTS "Users can insert own snapshots" ON trade_snapshots;
DROP POLICY IF EXISTS "Users can delete own snapshots" ON trade_snapshots;
CREATE POLICY "Users can view own snapshots"   ON trade_snapshots FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own snapshots" ON trade_snapshots FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own snapshots" ON trade_snapshots FOR DELETE USING (auth.uid() = user_id);

-- ── WATCHLIST MODE ──
ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS mode         TEXT DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS triggered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rpt          NUMERIC;       -- per-item RPT override (null = Settings default)
UPDATE watchlist SET mode = 'both' WHERE mode IS NULL;
ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_mode_check;
ALTER TABLE watchlist ADD CONSTRAINT watchlist_mode_check CHECK (mode IN ('real','paper','both'));

-- ============================================================
-- DONE
-- ============================================================
