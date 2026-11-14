-- Read-only upstream machine selection metadata, scoped to the active binding.
ALTER TABLE public.rpa_tasks
  ADD COLUMN schedule_dispatch JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN schedule_dispatch_synced_at TIMESTAMPTZ,
  ADD COLUMN schedule_dispatch_error TEXT;
ALTER TABLE public.rpa_tasks ADD CONSTRAINT ck_rpa_tasks_schedule_dispatch_object
  CHECK (jsonb_typeof(schedule_dispatch) = 'object');
