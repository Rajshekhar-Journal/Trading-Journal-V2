-- ============================================================
-- Trading Journal — Migration 010: Auto Trade Engine, Phase 2 (SHADOW)
-- Adds order_intents: what the engine WOULD send to the broker, with the result of every guard.
-- In shadow mode nothing is sent. Rows are append-only (no update or delete policy), so the table
-- is also the audit trail of every shadow decision.
-- Additive only. Safe to re-run. Run in Supabase SQL Editor AFTER 009.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_intents (
  id                TEXT PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  intent_key        TEXT NOT NULL,               -- same signal → same key → one intent
  mode              TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','confirm','auto')),
  status            TEXT NOT NULL,               -- shadow_ok | shadow_blocked | shadow_noop | shadow_tracked
  action            TEXT NOT NULL,               -- ENTRY | ADD | STOP_ENSURE | TRAIL_TRACK | EXIT_PARTIAL | EXIT_ALL
  rule_id           TEXT NOT NULL,               -- LC-01 .. LC-10
  symbol            TEXT NOT NULL,
  exchange          TEXT DEFAULT 'NSE',
  trade_id          TEXT,
  watchlist_id      TEXT,
  alert_id          TEXT,                        -- alert_log.id that produced this intent
  side              TEXT CHECK (side IN ('BUY','SELL')),
  qty               INTEGER,
  route             TEXT NOT NULL,               -- LIMIT_IOC | GTT | MARKET | NONE
  limit_price       NUMERIC,
  trigger_price     NUMERIC,
  gtt_limit_price   NUMERIC,
  market_protection NUMERIC,
  ref_price         NUMERIC,                     -- price when the intent was made
  stop_price        NUMERIC,
  order_value       NUMERIC,
  would_send        BOOLEAN NOT NULL DEFAULT FALSE,
  block_reasons     JSONB DEFAULT '[]'::JSONB,
  guards            JSONB DEFAULT '[]'::JSONB,   -- [{ id, ok, level, detail }]
  detail            JSONB DEFAULT '{}'::JSONB,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS order_intents_user_key_uidx ON order_intents (user_id, intent_key);
CREATE INDEX IF NOT EXISTS order_intents_user_time_idx ON order_intents (user_id, created_at DESC);

ALTER TABLE order_intents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own intents select" ON order_intents;
DROP POLICY IF EXISTS "own intents insert" ON order_intents;
CREATE POLICY "own intents select" ON order_intents FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own intents insert" ON order_intents FOR INSERT WITH CHECK (auth.uid() = user_id);
-- No UPDATE or DELETE policy on purpose: shadow intents cannot be edited or removed from the app.

-- Position protection report: the gateway stores the protection state of every open position
-- (PROTECTED / PARTIAL / UNPROTECTED) as one more snapshot kind.
ALTER TABLE broker_snapshots DROP CONSTRAINT IF EXISTS broker_snapshots_kind_check;
ALTER TABLE broker_snapshots ADD CONSTRAINT broker_snapshots_kind_check CHECK (kind IN ('holdings','positions','funds','protection'));

-- Check:  SELECT created_at, symbol, action, qty, route, status, block_reasons FROM order_intents ORDER BY created_at DESC LIMIT 20;
