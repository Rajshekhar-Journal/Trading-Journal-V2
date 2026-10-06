-- ============================================================
-- 007 — Chartbook: entry / add / exit charts per trade + notes & lessons
-- Run in Supabase → SQL Editor. Safe to run more than once.
-- ============================================================

-- 1. Chart kind and "final" flag (a chart taken during the session is re-taken after the close)
ALTER TABLE trade_snapshots ADD COLUMN IF NOT EXISTS kind  TEXT;
ALTER TABLE trade_snapshots ADD COLUMN IF NOT EXISTS final BOOLEAN DEFAULT FALSE;
UPDATE trade_snapshots
   SET kind = CASE rule_id WHEN 'LC-02' THEN 'add' WHEN 'EXIT' THEN 'exit' ELSE 'entry' END
 WHERE kind IS NULL;
CREATE INDEX IF NOT EXISTS trade_snapshots_user_trade_idx ON trade_snapshots (user_id, trade_id);

-- Charts are replaced in place when finalised (upsert), so owners may update their own rows.
DROP POLICY IF EXISTS "Users can update own snapshots" ON trade_snapshots;
CREATE POLICY "Users can update own snapshots" ON trade_snapshots
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 2. Notes & lessons per trade (real or paper)
CREATE TABLE IF NOT EXISTS chartbook_notes (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trade_id   TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'real' CHECK (mode IN ('real','paper')),
  notes      TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, trade_id)
);
ALTER TABLE chartbook_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own chartbook notes" ON chartbook_notes;
CREATE POLICY "Users manage own chartbook notes" ON chartbook_notes
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Check:  SELECT kind, final, count(*) FROM trade_snapshots GROUP BY 1, 2;
