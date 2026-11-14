const { z } = require('zod');
const { withTransaction } = require('../db/repositoryUtils.cjs');
const { taskSnapshot, SNAPSHOT_FIELDS, isVisibilityHistory } = require('../db/taskHistoryRepository.cjs');
const { timestampAfter } = require('../db/values.cjs');
const { addAudit, normalizeActor, withAdminAudit } = require('./taskMutationService.cjs');
const { AuthorizationError, AdminRequiredError, ConflictError, NotFoundError, ValidationError, databaseError } = require('../errors.cjs');
const { isValidBigintId } = require('./taskValidation.cjs');

const snapshotSchema = z.object({
  schema_version: z.literal(1), task: z.string().min(1).max(200),
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
  finish: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
  bot: z.string().min(1).max(100), tags: z.array(z.string().max(50)).max(20), note: z.string().max(2000),
  timing_mode: z.enum(['single', 'cron']).optional().default('single'),
  expected_duration_seconds: z.number().int().min(1).max(86400).optional().default(60),
  owner_user_id: z.string().refine(isValidBigintId).nullable(),
  schedule_uuid: z.string().min(1).max(200).nullable(), bound: z.boolean(), deleted: z.boolean(),
  is_hidden: z.boolean().optional(), operation_scope: z.literal('visibility').optional(),
}).strict().refine(s => (s.schedule_uuid == null) === !s.bound && (!s.deleted || !s.bound));

function restorationTarget(history, current) {
  if (!history.snapshot_complete || history.action === 'run_now') {
    throw new ConflictError('HISTORY_NOT_RESTORABLE', '该记录没有完整快照或属于执行操作，无法还原');
  }
  if (history.reverted_by_audit_id) throw new ConflictError('HISTORY_ALREADY_RESTORED', '该记录已经还原');
  if (history.before_snapshot == null) {
    if (!['create', 'import'].includes(history.action)) throw new ConflictError('HISTORY_INCOMPLETE', '历史快照不完整');
    return { ...taskSnapshot(current), deleted: true, bound: false, schedule_uuid: null };
  }
  const result = snapshotSchema.safeParse(history.before_snapshot);
  if (!result.success) throw new ConflictError('HISTORY_INCOMPLETE', '历史快照不完整，不能安全还原');
  if (isVisibilityHistory(history)) return { ...taskSnapshot(current), is_hidden: result.data.is_hidden };
  const { operation_scope, ...target } = result.data;
  return { ...target, is_hidden: target.is_hidden ?? Boolean(current.is_hidden) };
}

function assertRestorePermission(actor, current, target) {
  if (!actor.isAdmin && (current.owner_user_id == null || String(current.owner_user_id) !== actor.userId)) {
    throw new AuthorizationError('只有当前任务所有者或管理员可以还原');
  }
  if (!actor.isAdmin && (!current.schedule_uuid || !current.schedule_bound_at) && !current.deleted_at) {
    throw new AdminRequiredError('历史未绑定任务仅管理员可还原');
  }
  if (!actor.isAdmin && !target.deleted && (!target.owner_user_id || !target.schedule_uuid || !target.bound)) {
    throw new AdminRequiredError('恢复到历史只读状态仅限管理员');
  }
}

function bindingWillChange(current, target) {
  return Boolean(current.deleted_at) !== target.deleted
    || (current.schedule_uuid || null) !== target.schedule_uuid
    || Boolean(current.schedule_uuid && current.schedule_bound_at && !current.deleted_at) !== target.bound;
}

function createTaskHistoryService({ pool, historyRepository, scheduleDirectory }) {
  async function context(actorInput, id, executor = pool, lock = false) {
    const actor = normalizeActor(actorInput);
    let history = await historyRepository.find(id, { executor });
    if (!history) throw new NotFoundError('记录已清理或不存在；每个任务保留最近 50 条');
    const { rows } = await executor.query(
      `SELECT * FROM public.rpa_tasks WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [history.task_id]
    );
    const current = rows[0];
    if (!current) throw new NotFoundError('任务不存在');
    // All history insertion/pruning takes the same task lock. Re-read after acquiring it.
    if (lock) {
      history = await historyRepository.find(id, { executor, forUpdate: true });
      if (!history) throw new NotFoundError('记录已清理，请刷新操作记录');
    }
    const target = restorationTarget(history, current);
    const visibilityOnly = isVisibilityHistory(history);
    if (visibilityOnly) {
      if (current.deleted_at) throw new ConflictError('TASK_DELETED', '任务已删除，不能调整隐藏状态');
    } else assertRestorePermission(actor, current, target);
    return { actor, history, current, target, visibilityOnly };
  }

  async function validateTarget({ current, target }, executor = pool, lock = false) {
    if (!target.deleted && target.owner_user_id) {
      const { rows } = await executor.query(
        `SELECT id FROM public.app_users WHERE id = $1 AND is_active = TRUE${lock ? ' FOR SHARE' : ''}`,
        [target.owner_user_id]
      );
      if (!rows[0]) throw new ConflictError('RESTORE_OWNER_INACTIVE', '原所有者不存在或已停用，无法还原');
    }
    if (bindingWillChange(current, target)) {
      const { rows } = await executor.query(
        `SELECT 1 FROM public.rpa_task_executions
         WHERE rpa_task_id = $1 AND normalized_status IN ('等待中', '运行中', '未知状态')
         UNION ALL SELECT 1 FROM public.rpa_task_run_requests
         WHERE rpa_task_id = $1 AND status IN ('pending', 'dispatching') LIMIT 1`, [current.id]
      );
      if (rows[0]) throw new ConflictError('TASK_ALREADY_ACTIVE', '任务有活动执行或待发送请求，暂不能改变绑定或删除状态');
    }
  }

  async function preflight(actor, id) {
    const ctx = await context(actor, id);
    if (!ctx.visibilityOnly) await validateTarget(ctx);
    if (!ctx.visibilityOnly && !ctx.target.deleted && ctx.target.schedule_uuid) {
      await scheduleDirectory.assertBindable(ctx.target.schedule_uuid, {
        actorUserId: ctx.actor.userId, excludeTaskId: String(ctx.current.id),
      });
    }
    return ctx;
  }

  async function preview(actor, id) {
    const ctx = await preflight(actor, id);
    const current = taskSnapshot(ctx.current);
    const userIds = [...new Set([current.owner_user_id, ctx.target.owner_user_id].filter(Boolean))];
    const owners = userIds.length ? await pool.query('SELECT id, display_name FROM public.app_users WHERE id = ANY($1::bigint[])', [userIds]) : { rows: [] };
    return {
      history_id: String(ctx.history.id), task_id: String(ctx.current.id), task_version: Number(ctx.current.version),
      current, target: ctx.target, visibility_only: ctx.visibilityOnly,
      owners: Object.fromEntries(owners.rows.map(row => [String(row.id), row.display_name])),
      changes: SNAPSHOT_FIELDS.filter(field => JSON.stringify(current[field]) !== JSON.stringify(ctx.target[field])),
    };
  }

  async function restore(actorInput, id, version) {
    // Validate remote plans before taking row locks. The transaction then revalidates
    // the version, authorization, active work and database uniqueness constraints.
    const preliminary = await preflight(actorInput, id);
    if (Number(preliminary.current.version) !== version) throw new ConflictError('VERSION_CONFLICT');
    try {
      return await withTransaction(pool, async client => {
        const ctx = await context(actorInput, id, client, true);
        const { current, target, actor, history } = ctx;
        if (Number(current.version) !== version) throw new ConflictError('VERSION_CONFLICT', '任务在确认期间已被修改，请重新预览');
        const snapshot = taskSnapshot(current);
        if (SNAPSHOT_FIELDS.every(field => JSON.stringify(snapshot[field]) === JSON.stringify(target[field]))) {
          throw new ConflictError('RESTORE_NO_CHANGES', '当前任务配置已与目标状态一致，无需还原');
        }
        if (ctx.visibilityOnly) {
          const { rows } = await client.query('UPDATE public.rpa_tasks SET is_hidden=$2 WHERE id=$1 RETURNING *', [current.id, target.is_hidden]);
          const auditId = await addAudit(client, { taskId: current.id, actorUserId: actor.userId, action: 'restore', historyScope: 'visibility',
            beforeTask: current, afterTask: rows[0], sourceAuditId: history.audit_log_id,
            oldValue: { is_hidden: current.is_hidden }, newValue: { is_hidden: target.is_hidden, scope: 'visibility' } });
          return { success: true, task_id: String(current.id), version: Number(rows[0].version), audit_id: String(auditId), message: '已还原隐藏状态，任务配置保持不变' };
        }
        await validateTarget(ctx, client, true);
        const bindingChanged = bindingWillChange(current, target);
        const { rows: boundaries } = await client.query(
          `SELECT MAX(GREATEST(bound_at, COALESCE(unbound_at, bound_at))) AS last_boundary
           FROM public.rpa_task_binding_history WHERE rpa_task_id = $1 OR schedule_uuid = $2`,
          [current.id, target.schedule_uuid]
        );
        const changedAt = timestampAfter(boundaries[0]?.last_boundary || current.schedule_bound_at);
        const scheduleUuid = target.deleted ? null : target.schedule_uuid;
        const boundAt = bindingChanged ? (target.bound ? changedAt : null) : current.schedule_bound_at;
        if (bindingChanged) {
          await client.query(
            `UPDATE public.rpa_task_binding_history SET unbound_at = $2
             WHERE rpa_task_id = $1 AND unbound_at IS NULL`, [current.id, changedAt]
          );
          if (target.bound && !target.deleted) {
            await client.query(
              `INSERT INTO public.rpa_task_binding_history (rpa_task_id, schedule_uuid, bound_at, actor_user_id)
               VALUES ($1, $2, $3, $4)`, [current.id, scheduleUuid, changedAt, actor.userId]
            );
          }
        }
        const { rows } = await client.query(
          `UPDATE public.rpa_tasks SET task = $2, start_time = $3, finish_time = $4,
             bot = $5, tags = $6::text[], note = $7, owner_user_id = $8, schedule_uuid = $9,
             timing_mode = $15, expected_duration_seconds = $16, is_hidden = $17,
             schedule_bound_at = $10, deleted_at = $11, version = version + 1, updated_at = $12,
             sync_generation = sync_generation + CASE WHEN $13 THEN 1 ELSE 0 END,
             last_synced_at = CASE WHEN $13 THEN NULL ELSE last_synced_at END,
             sync_error = CASE WHEN $13 THEN NULL ELSE sync_error END,
             schedule_cron_expression = CASE WHEN $13 THEN NULL ELSE schedule_cron_expression END,
             schedule_cron_synced_at = CASE WHEN $13 THEN NULL ELSE schedule_cron_synced_at END,
             schedule_cron_error = CASE WHEN $13 THEN NULL ELSE schedule_cron_error END,
             schedule_dispatch = CASE WHEN $13 THEN '{}'::jsonb ELSE schedule_dispatch END,
             schedule_dispatch_synced_at = CASE WHEN $13 THEN NULL ELSE schedule_dispatch_synced_at END,
             schedule_dispatch_error = CASE WHEN $13 THEN NULL ELSE schedule_dispatch_error END
           WHERE id = $1 AND version = $14 RETURNING *`,
          [current.id, target.task, target.start, target.finish, target.bot, target.tags, target.note,
            target.owner_user_id, scheduleUuid, boundAt, target.deleted ? changedAt : null, changedAt, bindingChanged, version,
            target.timing_mode, target.expected_duration_seconds, target.is_hidden]
        );
        if (!rows[0]) throw new ConflictError('VERSION_CONFLICT');
        const auditId = await addAudit(client, {
          taskId: current.id, actorUserId: actor.userId, action: 'restore',
          beforeTask: current, afterTask: rows[0], sourceAuditId: history.audit_log_id,
          oldValue: taskSnapshot(current),
          newValue: withAdminAudit({ ...taskSnapshot(rows[0]), source_audit_id: String(history.audit_log_id) }, actor, current.owner_user_id),
        });
        return { success: true, task_id: String(current.id), version: Number(rows[0].version), audit_id: String(auditId), message: '已还原该任务，其他任务保持不变' };
      });
    } catch (error) { throw databaseError(error); }
  }

  async function annotate(actorInput, id, { annotation, version }) {
    const actor = normalizeActor(actorInput);
    const history = await historyRepository.find(id);
    if (!history) throw new NotFoundError('操作记录已清理或不存在');
    if (String(history.actor_user_id) !== actor.userId) throw new AuthorizationError('仅原操作人可以修改这条记录的备注');
    const { rows } = await pool.query(
      `UPDATE public.rpa_task_operation_history SET annotation = $3, annotation_version = annotation_version + 1,
         annotation_updated_at = clock_timestamp()
       WHERE id = $1 AND actor_user_id = $2 AND annotation_version = $4
       RETURNING annotation, annotation_version`, [id, actor.userId, annotation, version]
    );
    if (!rows[0]) throw new ConflictError('ANNOTATION_CONFLICT', '备注已更新或记录已清理，请刷新后重试');
    return rows[0];
  }

  return { preview, restore, annotate };
}

module.exports = { createTaskHistoryService, restorationTarget, assertRestorePermission, bindingWillChange };
