-- Unbound upstream plans have no local task ID; creation reminders are keyed by plan UUID.
CREATE TABLE public.rpa_plan_creation_whitelist (
  schedule_uuid TEXT PRIMARY KEY,
  plan_name TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES public.app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
