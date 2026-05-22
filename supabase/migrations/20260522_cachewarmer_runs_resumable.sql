ALTER TABLE public.cachewarmer_runs
  ADD COLUMN IF NOT EXISTS cursor integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
