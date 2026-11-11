-- ============================================================
-- Trading Journal — Migration 011: Auto Trade Engine, Phase 3 (stop GTT in CONFIRM mode)
-- Lets you approve a proposed stop GTT in the journal and lets the Order Gateway record what it did.
-- Intents still cannot be edited freely: the only changes allowed are the status moves below,
-- made through two functions that check the current status first (compare-and-swap).
--   proposed → approved | rejected | expired        (you, in the journal)
--   approved → sending | expired                    (gateway claims it once)
--   sending  → done | failed | unknown              (gateway result)
--   unknown  → done | failed                        (gateway, after checking the broker)
-- Adds order_audit: an append-only log of every step the gateway takes.
-- Additive only. Safe to re-run. Run in Supabase SQL Editor AFTER 010.
-- ============================================================

ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS decided_at  TIMESTAMPTZ;
ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS result      JSONB;
ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS broker_ref  TEXT;          -- GTT id at the broker
ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS order_intents_user_status_idx ON order_intents (user_id, status);

-- You approve or reject a proposed intent. Returns the new status.
CREATE OR REPLACE FUNCTION public.exec_decide_intent(p_id TEXT, p_approve BOOLEAN)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status TEXT; v_expires TIMESTAMPTZ; v_new TEXT;
BEGIN
  SELECT status, expires_at INTO v_status, v_expires FROM order_intents WHERE id = p_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_status <> 'proposed' THEN RETURN v_status; END IF;
  v_new := CASE WHEN v_expires IS NOT NULL AND v_expires < now() THEN 'expired' WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE order_intents SET status = v_new, decided_at = now(), updated_at = now(),
         expires_at = CASE WHEN v_new = 'approved' THEN now() + interval '5 minutes' ELSE expires_at END   -- the gateway must act within 5 minutes
   WHERE id = p_id AND user_id = auth.uid();
  RETURN v_new;
END $$;

-- The gateway moves an intent from one status to the next. True only if it was in p_from.
CREATE OR REPLACE FUNCTION public.exec_intent_transition(p_id TEXT, p_from TEXT, p_to TEXT, p_result JSONB DEFAULT NULL, p_broker_ref TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT ((p_from = 'approved' AND p_to IN ('sending','expired'))
       OR (p_from = 'sending'  AND p_to IN ('done','failed','unknown'))
       OR (p_from = 'unknown'  AND p_to IN ('done','failed'))) THEN
    RETURN FALSE;
  END IF;
  UPDATE order_intents
     SET status = p_to, result = COALESCE(p_result, result), broker_ref = COALESCE(p_broker_ref, broker_ref), updated_at = now()
   WHERE id = p_id AND user_id = auth.uid() AND status = p_from AND mode = 'confirm';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.exec_decide_intent(TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.exec_intent_transition(TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_decide_intent(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.exec_intent_transition(TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated;

-- ── ORDER AUDIT (append-only) ──
CREATE TABLE IF NOT EXISTS order_audit (
  id         TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  intent_id  TEXT NOT NULL,
  symbol     TEXT,
  event      TEXT NOT NULL,          -- claimed | refused | already_in_place | sending_place | sending_modify | broker_refused | unknown | unverified | done | …
  detail     JSONB DEFAULT '{}'::JSONB,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_audit_intent_idx ON order_audit (intent_id, at);
ALTER TABLE order_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own audit select" ON order_audit;
DROP POLICY IF EXISTS "own audit insert" ON order_audit;
CREATE POLICY "own audit select" ON order_audit FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own audit insert" ON order_audit FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Check:  SELECT symbol, status, trigger_price, qty, broker_ref, result FROM order_intents WHERE mode = 'confirm' ORDER BY created_at DESC LIMIT 20;
--         SELECT at, symbol, event, detail FROM order_audit ORDER BY at DESC LIMIT 30;
