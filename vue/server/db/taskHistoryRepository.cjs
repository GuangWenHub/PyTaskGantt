const { resolveExecutor } = require('./repositoryUtils.cjs');

const HISTORY_LIMIT = 50;
const SNAPSHOT_FIELDS = ['task', 'start', 'finish', 'bot', 'tags', 'note', 'timing_mode', 'expected_duration_seconds', 'owner_user_id', 'schedule_uuid', 'bound', 'deleted', 'is_hidden'];

function isVisibilityHistory(history) {
  const before = history.before_snapshot, after = history.after_snapshot;
  return before?.operation_scope === 'visibility' && after?.operation_scope === 'visibility'
    && typeof before.is_hidden === 'boolean' && typeof after.is_hidden === 'boolean'
    && SNAPSHOT_FIELDS.filter(field => field !== 'is_hidden').every(field => JSON.stringify(before[field]) === JSON.stringify(after[field]));
}

function taskSnapshot(row) {
  if (!row) return null;
  return {
    schema_version: 1,
    task: row.task,
    start: row.start_time ?? row.start,
    finish: row.finish_time ?? row.finish,
    bot: row.bot,
    tags: [...(row.tags || [])],
    note: row.note || '',
    timing_mode: row.timing_mode || 'single',
    expected_duration_seconds: Number(row.expected_duration_seconds || 60),
    owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id),
    schedule_uuid: row.schedule_uuid || null,
    bound: Boolean(row.schedule_uuid && row.schedule_bound_at && !row.deleted_at),
    deleted: Boolean(row.deleted_at),
    is_hidden: Boolean(row.is_hidden),
  };
}

// Call only inside the task's write transaction, while holding its row lock.
async function appendTaskHistory(client, entry) {
  const { taskId, actorUserId, action, auditId, beforeTask, afterTask, sourceAuditId = null, historyScope } = entry;
  const snapshot = task => {
    const value = taskSnapshot(task);
    return value && historyScope === 'visibility' ? { ...value, operation_scope: 'visibility' } : value;
  };
  // Execution completion holds an outbox lock rather than the task lock.
  if (action === 'run_now') await client.query('SELECT id FROM public.rpa_tasks WHERE id = $1 FOR UPDATE', [taskId]);
  if (sourceAuditId) {
    await client.query(
      `UPDATE public.rpa_task_operation_history SET reverted_by_audit_id = $2
       WHERE audit_log_id = $1 AND task_id = $3`, [sourceAuditId, auditId, taskId]
    );
  }
  await client.query(
    `INSERT INTO public.rpa_task_operation_history
       (audit_log_id, task_id, task_name, actor_user_id, action,
        before_snapshot, after_snapshot, snapshot_complete, before_version, after_version, source_audit_id)
     SELECT $1, task.id, task.task, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10
     FROM public.rpa_tasks AS task WHERE task.id = $2`,
    [auditId, taskId, actorUserId, action,
      JSON.stringify(snapshot(beforeTask)), JSON.stringify(snapshot(afterTask)),
      afterTask !== undefined && (beforeTask !== undefined || ['create', 'import'].includes(action)),
      beforeTask?.version ?? null, afterTask?.version ?? null, sourceAuditId]
  );
  await client.query(
    `DELETE FROM public.rpa_task_operation_history
     WHERE task_id = $1 AND id NOT IN (
       SELECT id FROM public.rpa_task_operation_history WHERE task_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2
     )`, [taskId, HISTORY_LIMIT]
  );
}

function createTaskHistoryRepository(db) {
  async function list(actor, filters = {}) {
    const params = [];
    const conditions = [];
    if (filters.task_ids) { params.push(filters.task_ids); conditions.push(`history.task_id = ANY($${params.length}::bigint[])`); }
    if (filters.task_id) { params.push(filters.task_id); conditions.push(`history.task_id = $${params.length}`); }
    if (filters.actor_id) { params.push(filters.actor_id); conditions.push(`history.actor_user_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const summary = await db.query(
      `SELECT COUNT(*)::integer AS retained_count,
         COUNT(*) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::integer AS today_count
       FROM public.rpa_task_operation_history AS history ${where}`, params
    );
    if (filters.before_id) { params.push(filters.before_id); conditions.push(`history.id < $${params.length}`); }
    params.push(filters.limit + 1);
    const limitParameter = params.length;
    params.push(((filters.page || 1) - 1) * filters.limit);
    const { rows } = await db.query(
      `SELECT history.*, actor.display_name AS actor_name,
         task.owner_user_id AS current_owner_id, task.version AS current_version,
         task.schedule_uuid AS current_schedule_uuid, task.schedule_bound_at AS current_bound_at, task.deleted_at AS current_deleted_at,
         reverter.actor_user_id AS reverted_by_user_id, reverting_user.display_name AS reverted_by_name
       FROM public.rpa_task_operation_history AS history
       JOIN public.rpa_tasks AS task ON task.id = history.task_id
       LEFT JOIN public.app_users AS actor ON actor.id = history.actor_user_id
       LEFT JOIN public.rpa_task_audit_log AS reverter ON reverter.id = history.reverted_by_audit_id
       LEFT JOIN public.app_users AS reverting_user ON reverting_user.id = reverter.actor_user_id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY history.id DESC LIMIT $${limitParameter} OFFSET $${params.length}`, params
    );
    const hasMore = rows.length > filters.limit;
    const records = rows.slice(0, filters.limit).map(row => {
      const canManage = isVisibilityHistory(row) ? actor.isAdmin && !row.current_deleted_at : actor.isAdmin || (row.current_owner_id != null && String(row.current_owner_id) === actor.userId);
      return {
        id: String(row.id), task_id: String(row.task_id), task_name: row.task_name,
        actor_user_id: row.actor_user_id == null ? null : String(row.actor_user_id), actor_name: row.actor_name || '历史操作人',
        action: row.action, before: row.before_snapshot, after: row.after_snapshot,
        snapshot_complete: row.snapshot_complete, created_at: row.created_at,
        annotation: row.annotation, annotation_version: row.annotation_version,
        can_annotate: row.actor_user_id != null && String(row.actor_user_id) === actor.userId,
        can_restore: Boolean(canManage && row.snapshot_complete && row.action !== 'run_now' && !row.reverted_by_audit_id),
        reverted: Boolean(row.reverted_by_audit_id), reverted_by_name: row.reverted_by_name || null,
      };
    });
    return { records, has_more: hasMore, next_cursor: hasMore ? records.at(-1).id : null, ...summary.rows[0] };
  }

  async function find(id, options = {}) {
    const executor = resolveExecutor(options, db);
    const { rows } = await executor.query(
      `SELECT * FROM public.rpa_task_operation_history WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`, [id]
    );
    return rows[0] || null;
  }

  return { list, find };
}

module.exports = { HISTORY_LIMIT, SNAPSHOT_FIELDS, taskSnapshot, appendTaskHistory, isVisibilityHistory, createTaskHistoryRepository };
