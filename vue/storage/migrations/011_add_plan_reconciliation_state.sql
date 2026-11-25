-- Shared comparison preferences and durable, bounded comparison snapshots.
CREATE TABLE public.rpa_plan_sync_whitelist (
  task_id BIGINT NOT NULL REFERENCES public.rpa_tasks(id) ON DELETE CASCADE,
  schedule_uuid TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('task','bot','timing_mode','start','finish','schedule_dispatch','schedule_cron_expression')),
  created_by BIGINT NOT NULL REFERENCES public.app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, schedule_uuid, field)
);
CREATE TABLE public.rpa_plan_scan_snapshots (
  id UUID PRIMARY KEY,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_plan_scan_snapshots_created ON public.rpa_plan_scan_snapshots (created_at DESC);
