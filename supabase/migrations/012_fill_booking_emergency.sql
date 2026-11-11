-- ============================================================
-- Trading Journal — Migration 012: Auto Trade Engine, Phase 4b/4c
--   4b  Journal booking: a sell the gateway completed is written into the existing trade record
--       (partial exit or final exit) in ONE transaction, once.
--   4c  Emergency Exit intents (action = 'EMERGENCY_EXIT') use the same tables; nothing new is needed
--       for them except the booking below.
--       A fill of the stop GTT itself (action = 'GTT_STOP_FILL') is booked the same way.
-- Additive only. Safe to re-run. Run in Supabase SQL Editor AFTER 011.
-- ============================================================

ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS booked_at TIMESTAMPTZ;   -- set when the fill is in the journal
ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS booking   TEXT;          -- booked_final | booked_partial | or why it was not booked

-- Books the filled quantity of one finished exit intent into its trade. Idempotent: a second call
-- returns 'already_booked'. Never books more than the intent quantity or more than the trade's open quantity.
CREATE OR REPLACE FUNCTION public.exec_commit_fill(
  p_intent_id TEXT, p_qty INTEGER, p_price NUMERIC, p_charges NUMERIC, p_date DATE, p_source TEXT, p_order_ref TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  i      order_intents%ROWTYPE;
  t      trades%ROWTYPE;
  v_open NUMERIC;
  v_rec  JSONB;
  v_out  TEXT;
  v_sum  NUMERIC;
BEGIN
  SELECT * INTO i FROM order_intents WHERE id = p_intent_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF i.booked_at IS NOT NULL THEN RETURN 'already_booked'; END IF;
  IF i.booking IS NOT NULL THEN RETURN i.booking; END IF;                    -- already decided it cannot be booked

  IF i.mode <> 'confirm' OR i.action NOT IN ('EXIT_PARTIAL','EXIT_ALL','EMERGENCY_EXIT','GTT_STOP_FILL') OR i.status NOT IN ('done','failed') THEN
    RETURN 'not_bookable';                                                    -- not final yet: try again later
  END IF;

  v_out := NULL;
  IF p_qty IS NULL OR p_qty <= 0 OR p_price IS NULL OR p_price <= 0 THEN v_out := 'nothing_filled';
  ELSIF p_qty > i.qty THEN v_out := 'qty_exceeds_intent';
  ELSIF i.trade_id IS NULL THEN v_out := 'no_trade';
  END IF;

  IF v_out IS NULL THEN
    SELECT * INTO t FROM trades WHERE id = i.trade_id AND user_id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN v_out := 'no_trade';
    ELSIF t.final_exit IS NOT NULL AND jsonb_typeof(t.final_exit) = 'object' THEN v_out := 'trade_closed';
    END IF;
  END IF;

  IF v_out IS NULL THEN
    v_open := 0;
    SELECT COALESCE(SUM((e->>'qty')::NUMERIC), 0) INTO v_sum FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.entries) = 'array' THEN t.entries ELSE '[]'::JSONB END) e;
    v_open := v_open + v_sum;
    SELECT COALESCE(SUM((e->>'qty')::NUMERIC), 0) INTO v_sum FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.pyramids) = 'array' THEN t.pyramids ELSE '[]'::JSONB END) e;
    v_open := v_open + v_sum;
    SELECT COALESCE(SUM((e->>'qty')::NUMERIC), 0) INTO v_sum FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.partial_exits) = 'array' THEN t.partial_exits ELSE '[]'::JSONB END) e;
    v_open := v_open - v_sum;

    IF p_qty > v_open THEN
      v_out := 'qty_exceeds_open';
    ELSE
      v_rec := jsonb_build_object(
        'id', 'ax_' || i.id, 'date', to_char(p_date, 'YYYY-MM-DD'), 'price', p_price, 'qty', p_qty,
        'charges', COALESCE(p_charges, 0), 'actionSource', p_source, 'auto', TRUE, 'orderRef', p_order_ref, 'intentId', i.id);
      IF p_qty = v_open THEN
        UPDATE trades SET final_exit = v_rec, updated_at = now() WHERE id = t.id AND user_id = auth.uid();
        v_out := 'booked_final';
      ELSE
        UPDATE trades SET partial_exits = (CASE WHEN jsonb_typeof(partial_exits) = 'array' THEN partial_exits ELSE '[]'::JSONB END) || jsonb_build_array(v_rec), updated_at = now()
         WHERE id = t.id AND user_id = auth.uid();
        v_out := 'booked_partial';
      END IF;
    END IF;
  END IF;

  UPDATE order_intents
     SET booking = v_out, booked_at = CASE WHEN v_out IN ('booked_final','booked_partial') THEN now() ELSE NULL END, updated_at = now()
   WHERE id = i.id AND user_id = auth.uid();

  -- The alert that asked for this exit is done when the whole quantity was sold.
  IF v_out IN ('booked_final','booked_partial') AND i.alert_id IS NOT NULL AND p_qty = i.qty THEN
    UPDATE alert_log SET status = 'Executed', executed_at = now() WHERE id = i.alert_id AND user_id = auth.uid() AND status = 'New';
  END IF;
  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.exec_commit_fill(TEXT, INTEGER, NUMERIC, NUMERIC, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_commit_fill(TEXT, INTEGER, NUMERIC, NUMERIC, DATE, TEXT, TEXT) TO authenticated;

-- Check:  SELECT symbol, action, status, qty, result->>'filled' AS filled, booking, booked_at FROM order_intents WHERE mode = 'confirm' ORDER BY created_at DESC LIMIT 20;
