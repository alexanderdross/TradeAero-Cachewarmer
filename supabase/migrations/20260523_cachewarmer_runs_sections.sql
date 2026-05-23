-- Add per-run sitemap-section scoping. NULL = walk the whole root sitemap
-- index (current behavior). Non-null = a JSONB array of shard URLs to walk
-- instead. Persisted on the run row so the resumable cron pipeline can
-- re-resolve the URL list deterministically on every tick.
ALTER TABLE cachewarmer_runs ADD COLUMN IF NOT EXISTS sections JSONB;

COMMENT ON COLUMN cachewarmer_runs.sections IS
  'Sitemap shard URLs the run is scoped to (e.g. only aircraft + jobs shards). NULL = walk the whole root index.';
