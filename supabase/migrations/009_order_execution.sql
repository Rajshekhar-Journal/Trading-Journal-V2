-- ============================================================
-- Trading Journal — Migration 009: Auto Trade Engine, part A (Phase 1: broker link, READ ONLY)
-- Adds the tables the Order Gateway writes: gateway health, broker snapshots, broker orders,
-- broker GTTs and the reconcile (drift) report. Nothing here places or changes an order.
-- Additive only. Safe to re-run. Run in Supabase SQL Editor AFTER 008.
-- Part B (order_intents, order_audit, symbol_leases, exec_commit_fill) arrives with Phase 2.
-- ============================================================

-- ── GATEWAY HEALTH (one row per user) ──
CREATE TABLE IF NOT EXISTS exec_state (
  user_id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gateway_version       TEXT,
  heartbeat_at          TIMESTAMPTZ,               -- stale (> 3 min) = gateway offline
  broker_connected      BOOLEAN NOT NULL DEFAULT FALSE,
  token_valid_until     TIMESTAMPTZ,               -- Kite token lapses 06:00 IST next day
  ip_ok                 BOOLEAN NOT NULL DEFAULT FALSE,
  ip_status             TEXT,                      -- match | mismatch | not_configured | lookup_failed
  ip_checked_at         TIMESTAMPTZ,
  order_sending_enabled BOOLEAN NOT NULL DEFAULT FALSE,   -- always false in Phase 1
  last_sync_at          TIMESTAMPTZ,
  last_sync_result      JSONB DEFAULT '{}'::JSONB, -- counts only
  open_drift_count      INTEGER NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── BROKER SNAPSHOTS (latest holdings / positions / funds) ──
CREATE TABLE IF NOT EXISTS broker_snapshots (
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('holdings','positions','funds')),
  data      JSONB NOT NULL DEFAULT '{}'::JSONB,
  taken_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind)
);

-- ── BROKER ORDERS (today's order book, as the broker reports it) ──
CREATE TABLE IF NOT EXISTS broker_orders (
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id          TEXT NOT NULL,
  status            TEXT,
  tradingsymbol     TEXT,
  exchange          TEXT,
  transaction_type  TEXT,
  order_type        TEXT,
  product           TEXT,
  quantity          NUMERIC,
  filled_quantity   NUMERIC,
  pending_quantity  NUMERIC,
  price             NUMERIC,
  trigger_price     NUMERIC,
  average_price     NUMERIC,
  tag               TEXT,
  status_message    TEXT,
  order_timestamp   TIMESTAMPTZ,
  raw               JSONB DEFAULT '{}'::JSONB,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, order_id)
);
CREATE INDEX IF NOT EXISTS broker_orders_user_time_idx ON broker_orders (user_id, order_timestamp DESC);

-- ── BROKER GTTs ──
CREATE TABLE IF NOT EXISTS broker_gtts (
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gtt_id          TEXT NOT NULL,
  status          TEXT,                            -- active | triggered | disabled | expired | cancelled | rejected | deleted
  gtt_type        TEXT,                            -- single | two-leg
  tradingsymbol   TEXT,
  exchange        TEXT,
  trigger_values  JSONB DEFAULT '[]'::JSONB,
  orders          JSONB DEFAULT '[]'::JSONB,
  expires_at      TIMESTAMPTZ,
  raw             JSONB DEFAULT '{}'::JSONB,
  present         BOOLEAN NOT NULL DEFAULT TRUE,   -- false = no longer in the broker's list
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, gtt_id)
);

-- ── DRIFT LOG (journal vs broker differences; reported, never auto-corrected) ──
CREATE TABLE IF NOT EXISTS drift_log (
  id             TEXT PRIMARY KEY,                 -- user:kind:symbol
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,                    -- QTY_MISMATCH | JOURNAL_ONLY | BROKER_ONLY | NO_STOP_GTT | GTT_QTY_MISMATCH | GTT_TRIGGER_MISMATCH | ORPHAN_GTT
  symbol         TEXT NOT NULL,
  severity       TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','high')),
  journal_qty    NUMERIC,
  broker_qty     NUMERIC,
  detail         JSONB DEFAULT '{}'::JSONB,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS drift_log_user_status_idx ON drift_log (user_id, status, last_seen_at DESC);

-- ── Row-level security: each user sees and writes only their own rows.
--    The Order Gateway signs in as the journal user, so these same policies bound it.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['exec_state','broker_snapshots','broker_orders','broker_gtts','drift_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "own rows select" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "own rows insert" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "own rows update" ON %I', t);
    EXECUTE format('CREATE POLICY "own rows select" ON %I FOR SELECT USING (auth.uid() = user_id)', t);
    EXECUTE format('CREATE POLICY "own rows insert" ON %I FOR INSERT WITH CHECK (auth.uid() = user_id)', t);
    EXECUTE format('CREATE POLICY "own rows update" ON %I FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)', t);
  END LOOP;
END $$;

-- Check:  SELECT heartbeat_at, broker_connected, ip_status, open_drift_count FROM exec_state;
--         SELECT kind, symbol, severity, journal_qty, broker_qty FROM drift_log WHERE status = 'open';
