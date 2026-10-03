-- ============================================================
-- 006 — Backend rule runner (Step 2) + security clean-up (Step 1)
-- Run in Supabase → SQL Editor AFTER the Telegram secret is set (see DEPLOY_STEP1_2.md).
-- Safe to run more than once.
-- ============================================================

-- 1. Runner heartbeat + lock (one rule cycle at a time, browser or server)
CREATE TABLE IF NOT EXISTS runner_status (
  id               TEXT PRIMARY KEY,
  locked_until     TIMESTAMPTZ,
  locked_by        TEXT,
  last_started_at  TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_result      JSONB,          -- counts only (users, alerts, errors) — no trade data
  updated_at       TIMESTAMPTZ DEFAULT now()
);
INSERT INTO runner_status (id) VALUES ('tlm-runner') ON CONFLICT (id) DO NOTHING;

ALTER TABLE runner_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "runner_status readable by signed-in users" ON runner_status;
CREATE POLICY "runner_status readable by signed-in users" ON runner_status
  FOR SELECT TO authenticated USING (true);
-- No insert/update/delete policies: only the functions below and the service role write it.

CREATE OR REPLACE FUNCTION public.tlm_runner_try_lock(p_holder TEXT, p_seconds INT DEFAULT 90)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_seconds IS NULL OR p_seconds < 1 OR p_seconds > 120 THEN p_seconds := 90; END IF;
  -- A browser may only lock in its own name.
  IF auth.role() = 'authenticated' AND p_holder IS DISTINCT FROM 'browser:' || auth.uid()::text THEN
    RETURN FALSE;
  END IF;
  UPDATE runner_status
     SET locked_until = now() + make_interval(secs => p_seconds), locked_by = p_holder, updated_at = now()
   WHERE id = 'tlm-runner'
     AND (locked_until IS NULL OR locked_until < now() OR locked_by = p_holder);
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.tlm_runner_unlock(p_holder TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE runner_status SET locked_until = NULL, locked_by = NULL, updated_at = now()
   WHERE id = 'tlm-runner' AND locked_by = p_holder;
END $$;

REVOKE ALL ON FUNCTION public.tlm_runner_try_lock(TEXT, INT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tlm_runner_unlock(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tlm_runner_try_lock(TEXT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tlm_runner_unlock(TEXT) TO authenticated, service_role;

-- 2. Telegram bot token now lives only in the Edge Function secret TELEGRAM_BOT_TOKEN.
--    Remove the copy stored in each user's settings (the chat id stays).
UPDATE settings SET data = data - 'telegramBotToken' WHERE data ? 'telegramBotToken';

-- 3. Every minute, 08:30–16:29 IST (03:00–10:59 UTC), Monday–Friday.
--    The function itself checks the 09:00–15:31 IST window and your market holidays.
--    The shared secret is read from Vault (created in DEPLOY_STEP1_2.md, step 4).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('tlm-runner') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tlm-runner');
SELECT cron.schedule(
  'tlm-runner',
  '* 3-10 * * 1-5',
  $$
    SELECT net.http_post(
      url     := 'https://zopskuwqlbteyiypwnid.supabase.co/functions/v1/tlm-runner',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'tlm_cron_secret')),
      body    := '{"action":"cron"}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

-- Check:  SELECT * FROM runner_status;                         -- last_finished_at moves every minute in market hours
--         SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
-- Stop:   SELECT cron.unschedule('tlm-runner');                 -- the browser takes over within 3 minutes
