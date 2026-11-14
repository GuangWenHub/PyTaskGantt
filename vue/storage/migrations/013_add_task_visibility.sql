-- Shared display preference only; never changes the upstream schedule.
ALTER TABLE public.rpa_tasks ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
