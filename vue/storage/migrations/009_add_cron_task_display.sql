-- Local presentation settings; remote Cron is a binding-scoped read cache.
ALTER TABLE public.rpa_tasks
  ADD COLUMN timing_mode TEXT NOT NULL DEFAULT 'single',
  ADD COLUMN expected_duration_seconds INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN schedule_cron_expression TEXT,
  ADD COLUMN schedule_cron_synced_at TIMESTAMPTZ,
  ADD COLUMN schedule_cron_error TEXT;

ALTER TABLE public.rpa_tasks ADD CONSTRAINT ck_rpa_tasks_timing_mode
  CHECK (timing_mode IN ('single', 'cron'));
ALTER TABLE public.rpa_tasks ADD CONSTRAINT ck_rpa_tasks_expected_duration
  CHECK (expected_duration_seconds BETWEEN 1 AND 86400);
