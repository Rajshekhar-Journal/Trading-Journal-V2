-- ============================================================
-- Trading Journal — Migration 013: Auto Trade Engine — Auto-Sell and Full Auto modes, buy orders
--   * decided_by: who approved an intent ('user' or 'auto').
--   * exec_auto_decide_intent(): the ONLY way an intent is approved without you. The database itself refuses unless
--       - your saved mode is auto_sell (sell side: stop GTT, exits) or auto_full (also buys),
--       - the kill switch is off (buys),
--       - you have approved and completed enough orders of that kind yourself (settings.execution.autoMinDone, never below 1, default 3).
--     The approval is valid for 5 minutes, like yours.
--   * exec_mark_booked(): marks a buy fill / stop revision as written into the journal (done by the journal engine).
-- Additive only. Safe to re-run. Run in Supabase SQL Editor AFTER 012.
-- ============================================================

ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS decided_by TEXT;           -- 'user' | 'auto'

-- Your approval now records that it was yours (same behaviour as before otherwise).
CREATE OR REPLACE FUNCTION public.exec_decide_intent(p_id TEXT, p_approve BOOLEAN)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status TEXT; v_expires TIMESTAMPTZ; v_new TEXT;
BEGIN
  SELECT status, expires_at INTO v_status, v_expires FROM order_intents WHERE id = p_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_status <> 'proposed' THEN RETURN v_status; END IF;
  v_new := CASE WHEN v_expires IS NOT NULL AND v_expires < now() THEN 'expired' WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE order_intents SET status = v_new, decided_at = now(), updated_at = now(), decided_by = 'user',
         expires_at = CASE WHEN v_new = 'approved' THEN now() + interval '5 minutes' ELSE expires_at END
   WHERE id = p_id AND user_id = auth.uid();
  RETURN v_new;
END $$;

-- Automatic approval. Returns 'approved', or why not ('not_allowed:...', 'expired', or the current status).
CREATE OR REPLACE FUNCTION public.exec_auto_decide_intent(p_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  i       order_intents%ROWTYPE;
  x       JSONB;
  v_mode  TEXT;
  v_min   INTEGER;
  v_class TEXT;
  v_done  INTEGER;
BEGIN
  SELECT * INTO i FROM order_intents WHERE id = p_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF i.status <> 'proposed' THEN RETURN i.status; END IF;
  IF i.mode <> 'confirm' THEN RETURN 'not_allowed:not a proposal'; END IF;
  IF i.expires_at IS NOT NULL AND i.expires_at < now() THEN
    UPDATE order_intents SET status = 'expired', decided_at = now(), updated_at = now() WHERE id = p_id AND user_id = auth.uid();
    RETURN 'expired';
  END IF;

  v_class := CASE WHEN i.action IN ('ENTRY','ADD') THEN 'buy' WHEN i.action IN ('STOP_ENSURE','EXIT_PARTIAL','EXIT_ALL') THEN 'sell' ELSE NULL END;
  IF v_class IS NULL THEN RETURN 'not_allowed:this kind of order is never approved automatically'; END IF;

  SELECT data->'execution' INTO x FROM settings WHERE user_id = auth.uid();
  v_mode := COALESCE(x->>'mode', 'alert');
  IF NOT ((v_mode = 'auto_sell' AND v_class = 'sell') OR v_mode = 'auto_full') THEN
    RETURN 'not_allowed:mode is ' || v_mode;
  END IF;
  IF v_class = 'buy' AND COALESCE((x->>'killSwitch')::BOOLEAN, FALSE) THEN RETURN 'not_allowed:kill switch is on'; END IF;

  v_min := GREATEST(1, COALESCE((x->>'autoMinDone')::INTEGER, 3));
  SELECT COUNT(*) INTO v_done FROM order_intents
   WHERE user_id = auth.uid() AND mode = 'confirm' AND status = 'done' AND decided_at IS NOT NULL AND decided_by IS DISTINCT FROM 'auto'
     AND ((v_class = 'sell' AND action IN ('STOP_ENSURE','EXIT_PARTIAL','EXIT_ALL')) OR (v_class = 'buy' AND action IN ('ENTRY','ADD')))
     AND ((action = 'STOP_ENSURE' AND result ? 'verb') OR (action <> 'STOP_ENSURE' AND COALESCE((result->>'filled')::NUMERIC, 0) > 0));
  IF v_done < v_min THEN RETURN 'not_allowed:track record ' || v_done || ' of ' || v_min || ' ' || v_class || ' orders approved by you'; END IF;

  UPDATE order_intents SET status = 'approved', decided_at = now(), updated_at = now(), decided_by = 'auto',
         expires_at = now() + interval '5 minutes'
   WHERE id = p_id AND user_id = auth.uid() AND status = 'proposed';
  RETURN 'approved';
END $$;

-- The journal engine marks a buy fill / stop revision as written into the journal. Idempotent.
CREATE OR REPLACE FUNCTION public.exec_mark_booked(p_intent_id TEXT, p_booking TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE order_intents
     SET booking = p_booking, booked_at = CASE WHEN p_booking LIKE 'booked\_%' THEN now() ELSE NULL END, updated_at = now()
   WHERE id = p_intent_id AND user_id = auth.uid() AND mode = 'confirm' AND action IN ('ENTRY','ADD','STOP_ENSURE')
     AND status IN ('done','failed') AND booking IS NULL;
  RETURN CASE WHEN FOUND THEN 'ok' ELSE 'not_updated' END;
END $$;

REVOKE ALL ON FUNCTION public.exec_decide_intent(TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.exec_auto_decide_intent(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.exec_mark_booked(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_decide_intent(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.exec_auto_decide_intent(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.exec_mark_booked(TEXT, TEXT) TO authenticated;

-- Check:  SELECT symbol, action, status, decided_by, result FROM order_intents WHERE mode = 'confirm' ORDER BY created_at DESC LIMIT 20;
