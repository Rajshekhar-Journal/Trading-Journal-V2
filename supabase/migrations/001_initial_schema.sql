-- ============================================================
-- Trading Journal — Supabase Database Schema
-- Phase 2 — Initial Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- ── Enable UUID extension ────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── TRADES table ─────────────────────────────────────────────
-- Stores the full single trade lifecycle as a JSONB document.
-- Each trade belongs to one user via user_id (RLS enforced).
CREATE TABLE IF NOT EXISTS trades (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('Long','Short')),
  trade_type      TEXT NOT NULL DEFAULT 'Equity',
  playbook_id     TEXT,
  initial_stop    NUMERIC,
  cmp             NUMERIC,
  entries         JSONB DEFAULT '[]'::JSONB,
  pyramids        JSONB DEFAULT '[]'::JSONB,
  partial_exits   JSONB DEFAULT '[]'::JSONB,
  final_exit      JSONB,
  stop_revisions  JSONB DEFAULT '[]'::JSONB,
  alerts          JSONB DEFAULT '[]'::JSONB,
  notes           JSONB DEFAULT '[]'::JSONB,
  rule_followed   BOOLEAN DEFAULT TRUE,
  rule_break_note TEXT,
  review_status   TEXT DEFAULT 'Pending',
  rating          INTEGER DEFAULT 0,
  tags            JSONB DEFAULT '[]'::JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── PLAYBOOKS table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS playbooks (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  version         TEXT DEFAULT '1.0',
  status          TEXT DEFAULT 'Draft' CHECK (status IN ('Draft','Active','Archived')),
  category        TEXT,
  description     TEXT,
  entry_rules     JSONB DEFAULT '[]'::JSONB,
  exit_rules      JSONB DEFAULT '[]'::JSONB,
  risk_rules      JSONB DEFAULT '[]'::JSONB,
  checklist       JSONB DEFAULT '[]'::JSONB,
  version_history JSONB DEFAULT '[]'::JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CAPITAL table ─────────────────────────────────────────────
-- One row per capital transaction (deposit/withdrawal/adjustment)
CREATE TABLE IF NOT EXISTS capital (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('Deposit','Withdrawal','Adjustment')),
  amount          NUMERIC NOT NULL,
  note            TEXT,
  running_balance NUMERIC DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── SETTINGS table ────────────────────────────────────────────
-- One row per user — stores all settings as a JSONB blob.
CREATE TABLE IF NOT EXISTS settings (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  data            JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── EQUITY SNAPSHOTS table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  equity          NUMERIC NOT NULL,
  UNIQUE (user_id, date)
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — Each user only sees their own data
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE trades           ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbooks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE capital          ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE equity_snapshots ENABLE ROW LEVEL SECURITY;

-- ── Trades RLS policies ───────────────────────────────────────
CREATE POLICY "Users can view own trades"   ON trades FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own trades" ON trades FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own trades" ON trades FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own trades" ON trades FOR DELETE USING (auth.uid() = user_id);

-- ── Playbooks RLS policies ────────────────────────────────────
CREATE POLICY "Users can view own playbooks"   ON playbooks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own playbooks" ON playbooks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own playbooks" ON playbooks FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own playbooks" ON playbooks FOR DELETE USING (auth.uid() = user_id);

-- ── Capital RLS policies ──────────────────────────────────────
CREATE POLICY "Users can view own capital"   ON capital FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own capital" ON capital FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own capital" ON capital FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own capital" ON capital FOR DELETE USING (auth.uid() = user_id);

-- ── Settings RLS policies ─────────────────────────────────────
CREATE POLICY "Users can view own settings"   ON settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own settings" ON settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own settings" ON settings FOR UPDATE USING (auth.uid() = user_id);

-- ── Equity Snapshots RLS policies ─────────────────────────────
CREATE POLICY "Users can view own snapshots"   ON equity_snapshots FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own snapshots" ON equity_snapshots FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own snapshots" ON equity_snapshots FOR UPDATE USING (auth.uid() = user_id);

-- ============================================================
-- AUTO-UPDATE updated_at on trades + playbooks + settings
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_updated_at    BEFORE UPDATE ON trades    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER playbooks_updated_at BEFORE UPDATE ON playbooks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER settings_updated_at  BEFORE UPDATE ON settings  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DONE — Run this entire script once in Supabase SQL Editor
-- ============================================================
