-- ============================================================
-- Trading Journal — Migration 015: approve / reject Confirm-mode proposals from Telegram.
--   * tg_notices: one row per proposal sent to Telegram with buttons (which chat, which message), and when its outcome was sent.
--   * decided_via: 'journal' or 'telegram'.
--   * exec_decide_intent_for(): the same decision as exec_decide_intent (status must still be 'proposed', expiry respected,
--     approval valid 5 minutes, counts as YOUR approval), for the Telegram webhook. Only the server (service role) may call it;
--     the webhook first checks Telegram's secret header, the button signature and that the tap came from your saved chat.
-- Additive only. Safe to re-run. Run in Supabase SQL Editor AFTER 014.
-- ============================================================

ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS decided_via TEXT;

CREATE TABLE IF NOT EXISTS tg_notices (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  intent_id       TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  message_id      BIGINT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided         TEXT,                  -- what the tap returned: approved | rejected | expired | <current status>
  result_sent_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS tg_notices_user_intent_uidx ON tg_notices (user_id, intent_id);
ALTER TABLE tg_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own tg notices" ON tg_notices;
CREATE POLICY "own tg notices" ON tg_notices FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.exec_decide_intent_for(p_user UUID, p_id TEXT, p_approve BOOLEAN)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status TEXT; v_expires TIMESTAMPTZ; v_mode TEXT; v_new TEXT;
BEGIN
  SELECT status, expires_at, mode INTO v_status, v_expires, v_mode FROM order_intents WHERE id = p_id AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_mode <> 'confirm' THEN RETURN 'not_allowed'; END IF;
  IF v_status <> 'proposed' THEN RETURN v_status; END IF;
  v_new := CASE WHEN v_expires IS NOT NULL AND v_expires < now() THEN 'expired' WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE order_intents SET status = v_new, decided_at = now(), updated_at = now(), decided_by = 'user', decided_via = 'telegram',
         expires_at = CASE WHEN v_new = 'approved' THEN now() + interval '5 minutes' ELSE expires_at END
   WHERE id = p_id AND user_id = p_user;
  RETURN v_new;
END $$;

REVOKE ALL ON FUNCTION public.exec_decide_intent_for(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exec_decide_intent_for(UUID, TEXT, BOOLEAN) TO service_role;

-- Check:  SELECT n.sent_at, i.symbol, i.action, i.status, i.decided_via, n.decided FROM tg_notices n JOIN order_intents i ON i.id = n.intent_id ORDER BY n.sent_at DESC LIMIT 20;
