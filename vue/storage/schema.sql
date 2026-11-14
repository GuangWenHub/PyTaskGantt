-- PyTaskGantt PostgreSQL schema snapshot / psql entrypoint.
--
-- Preferred command (validates checksums and applies only pending versions):
--   node storage/migrate.cjs
--
-- This file remains a DBA-friendly, atomic psql entrypoint for a fresh database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f storage/schema.sql
-- It includes the same ordered migration files and records their exact checksums,
-- so the application startup version check recognizes the resulting schema.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  checksum    CHAR(64) NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

\ir migrations/001_add_users_and_task_ownership.sql
\ir migrations/002_add_executions_and_binding_history.sql
\ir migrations/003_add_audit_and_sessions.sql
\ir migrations/004_finalize_postgres_only_schema.sql
\ir migrations/005_add_durable_run_requests.sql
\ir migrations/006_add_binding_scoped_sync_generation.sql
\ir migrations/007_add_admin_permission.sql
\ir migrations/008_add_task_operation_history.sql
\ir migrations/009_add_cron_task_display.sql
\ir migrations/010_add_schedule_dispatch_cache.sql
\ir migrations/011_add_plan_reconciliation_state.sql
\ir migrations/012_add_plan_creation_whitelist.sql
\ir migrations/013_add_task_visibility.sql

INSERT INTO public.schema_migrations (version, name, checksum) VALUES
  (1, '001_add_users_and_task_ownership.sql',
   'c075042c15624ff876a2b690fba16a97ea8e7608564a159fb25e9450d2c4b7f2'),
  (2, '002_add_executions_and_binding_history.sql',
   'a7ac23418c0a5e5d91a9aca9018551bb0df14db522634c61d558eb6f13d4436c'),
  (3, '003_add_audit_and_sessions.sql',
   '9db862eebac53e2eccbd38946c7e9c0e9a9794f0d0cf382022fb43990af3c875'),
  (4, '004_finalize_postgres_only_schema.sql',
   '98ba7f05055bf6b886605f6da3edcc71f66d4c3d2b9fce124d33de834dd190df'),
  (5, '005_add_durable_run_requests.sql',
   'c6e6b76cb0d7d8cd51453f88bdb0b7ba1531b28928e7ef89b064926b6d339737'),
  (6, '006_add_binding_scoped_sync_generation.sql',
   '60168641cc15991754ab058d321cec2176c01daddbf057cc2cf4a5a0acb7e12d'),
  (7, '007_add_admin_permission.sql',
   'a4e8ac1df160e4ef9386b48707760f632a82b763009c2a5c5276545d0f01fe57'),
  (8, '008_add_task_operation_history.sql', 'faa7055693b15ec1eff30d217ec83577c56813a9f9706884323867b813b4002d'),
  (9, '009_add_cron_task_display.sql', 'e1a9aeb24a8e0fd9afcadeabbb96204bf608d8141fc422887c8297d6e8fb62a1'),
  (10, '010_add_schedule_dispatch_cache.sql', '3d21403bb63540d98263e0977394812cfd13fdc6d657f412bd3a52960cf9e008'),
  (11, '011_add_plan_reconciliation_state.sql', 'fc4e832927fd7a72b6ff4b7bf16e90028f4485a4e870d26400059cb0ea68abce'),
  (12, '012_add_plan_creation_whitelist.sql', 'f92d94fe15b9fb895c7525eda798addfa0e83f57525d2df170b2f372b5d284e0'),
  (13, '013_add_task_visibility.sql', '8fa61182c16be960e943342b8e51485ec93ee47bbb31aa320fdf16d26a16bf90')
ON CONFLICT (version) DO NOTHING;

COMMIT;
