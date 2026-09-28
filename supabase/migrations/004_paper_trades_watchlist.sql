-- ============================================================
-- Trading Journal — Migration 004
-- Creates the missing paper_trades and watchlist tables (with RLS)
-- and adds entry_atr / swing_low (used by the alert engine) to trades.
-- Safe to re-run: every statement is IF NOT EXISTS / drop-then-create.
-- Run in Supabase SQL Editor AFTER 001, 002 and 003.
-- ============================================================

-- ── TRADES: columns the code already writes but no migration added ──
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS entry_atr         NUMERIC,
  ADD COLUMN IF NOT EXISTS swing_low         NUMERIC,
  ADD COLUMN IF NOT EXISTS position_size_max NUMERIC,   -- reserved for SRS DM-01
  ADD COLUMN IF NOT EXISTS tlm_state         JSONB;     -- reserved for SRS DM-02

-- ── PAPER_TRADES: same shape as trades (001 + 002 + extras) ──
CREATE TABLE IF NOT EXISTS paper_trades (
  id               TEXT PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol           TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('Long','Short')),
  trade_type       TEXT NOT NULL DEFAULT 'Equity',
  playbook_id      TEXT,
  initial_stop     NUMERIC,
  cmp              NUMERIC,
  entries          JSONB DEFAULT '[]'::JSONB,
  pyramids         JSONB DEFAULT '[]'::JSONB,
  partial_exits    JSONB DEFAULT '[]'::JSONB,
  final_exit       JSONB,
  stop_revisions   JSONB DEFAULT '[]'::JSONB,
  alerts           JSONB DEFAULT '[]'::JSONB,
  notes            JSONB DEFAULT '[]'::JSONB,
  rule_followed    BOOLEAN DEFAULT TRUE,
  rule_break_note  TEXT,
  review_status    TEXT DEFAULT 'Paper',
  rating           INTEGER DEFAULT 0,
  tags             JSONB DEFAULT '[]'::JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- If paper_trades was created by hand earlier, make sure every column exists
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS sector            TEXT,
  ADD COLUMN IF NOT EXISTS exchange          TEXT DEFAULT 'NSE',
  ADD COLUMN IF NOT EXISTS current_stop      NUMERIC,
  ADD COLUMN IF NOT EXISTS rpt               NUMERIC,
  ADD COLUMN IF NOT EXISTS chart_link        TEXT,
  ADD COLUMN IF NOT EXISTS playbook_version  TEXT,
  ADD COLUMN IF NOT EXISTS closed_at         DATE,
  ADD COLUMN IF NOT EXISTS entry_atr         NUMERIC,
  ADD COLUMN IF NOT EXISTS swing_low         NUMERIC,
  ADD COLUMN IF NOT EXISTS position_size_max NUMERIC,
  ADD COLUMN IF NOT EXISTS tlm_state         JSONB;

CREATE INDEX IF NOT EXISTS paper_trades_user_idx ON paper_trades (user_id, created_at DESC);

-- ── WATCHLIST ──
-- id is TEXT because the app falls back to 'wl_<timestamp>_<rand>' ids
CREATE TABLE IF NOT EXISTS watchlist (
  id             TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol         TEXT NOT NULL,
  sector         TEXT,
  trigger_price  NUMERIC,
  stop_loss      NUMERIC,
  notes          TEXT,
  status         TEXT DEFAULT 'monitoring' CHECK (status IN ('monitoring','triggered','executed')),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS sector        TEXT,
  ADD COLUMN IF NOT EXISTS trigger_price NUMERIC,
  ADD COLUMN IF NOT EXISTS stop_loss     NUMERIC,
  ADD COLUMN IF NOT EXISTS notes         TEXT,
  ADD COLUMN IF NOT EXISTS status        TEXT DEFAULT 'monitoring',
  ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS watchlist_user_idx ON watchlist (user_id, created_at DESC);

-- ── ROW LEVEL SECURITY ──
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own paper trades"   ON paper_trades;
DROP POLICY IF EXISTS "Users can insert own paper trades" ON paper_trades;
DROP POLICY IF EXISTS "Users can update own paper trades" ON paper_trades;
DROP POLICY IF EXISTS "Users can delete own paper trades" ON paper_trades;
CREATE POLICY "Users can view own paper trades"   ON paper_trades FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own paper trades" ON paper_trades FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own paper trades" ON paper_trades FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own paper trades" ON paper_trades FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own watchlist"   ON watchlist;
DROP POLICY IF EXISTS "Users can insert own watchlist" ON watchlist;
DROP POLICY IF EXISTS "Users can update own watchlist" ON watchlist;
DROP POLICY IF EXISTS "Users can delete own watchlist" ON watchlist;
CREATE POLICY "Users can view own watchlist"   ON watchlist FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own watchlist" ON watchlist FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own watchlist" ON watchlist FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own watchlist" ON watchlist FOR DELETE USING (auth.uid() = user_id);

-- ── updated_at trigger (function defined in 001) ──
DROP TRIGGER IF EXISTS paper_trades_updated_at ON paper_trades;
CREATE TRIGGER paper_trades_updated_at BEFORE UPDATE ON paper_trades
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DONE
-- ============================================================
