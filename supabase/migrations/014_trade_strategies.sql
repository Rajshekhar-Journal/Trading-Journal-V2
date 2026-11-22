-- 014: trade-management strategies.
-- A watchlist item can name the strategy its trade will follow (A, B, or a custom id). Empty = the default in Settings.
-- The strategy of an open trade lives in the trade's lifecycle state (tlm_state), so nothing else changes.
-- Custom strategies are stored in the settings row (settings.data.strategies), no table needed.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS strategy TEXT;
-- Check:  SELECT symbol, status, strategy FROM watchlist ORDER BY created_at DESC LIMIT 10;
