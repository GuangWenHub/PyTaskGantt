// Separate advisory locks serialize scans and whitelist/application changes.
const SCAN_LOCK = 1876249128, POLICY_LOCK = 1876249129;
const { Client } = require('pg');
const { withTransaction } = require('./repositoryUtils.cjs');
const { AuthorizationError, ConflictError } = require('../errors.cjs');
function createPlanReconciliationRepository(pool) {
  async function acquire(key, wait = false) {
    // Do not reserve a pool slot during upstream I/O or a nested mutation.
    // This also works with PGPOOL_MAX=1.
    const client = new Client(pool.options);
    let disconnected = false;
    client.on('error', () => { disconnected = true; });
    try {
      await client.connect();
      const { rows } = await client.query(wait ? 'SELECT pg_advisory_lock($1)' : 'SELECT pg_try_advisory_lock($1) AS locked', [key]);
      if (!wait && !rows[0].locked) { await client.end(); return null; }
      const release = async () => {
        try { if (!disconnected) await client.query('SELECT pg_advisory_unlock($1)', [key]); }
        finally { await client.end().catch(() => {}); }
      };
      release.assertHeld = () => { if (disconnected) throw new Error('Database comparison lock was disconnected'); };
      return release;
    } catch (error) { await client.end().catch(() => {}); throw error; }
  }
  return {
    acquireScanLock: () => acquire(SCAN_LOCK),
    async withPolicyLock(action) {
      const release = await acquire(POLICY_LOCK, true);
      try { return await action(release.assertHeld); } finally { await release(); }
    },
    async save(job, { executor = pool } = {}) {
      await executor.query(`INSERT INTO public.rpa_plan_scan_snapshots (id, payload) VALUES ($1,$2::jsonb)
        ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()`, [job.id, JSON.stringify({ ...job, applying: false })]);
      // Keep the latest ready result even after its write deadline has expired.
      await executor.query(`DELETE FROM public.rpa_plan_scan_snapshots WHERE id NOT IN
        (SELECT id FROM public.rpa_plan_scan_snapshots ORDER BY created_at DESC LIMIT 20)
        AND id IS DISTINCT FROM (SELECT id FROM public.rpa_plan_scan_snapshots
          WHERE payload->>'state'='ready' ORDER BY created_at DESC LIMIT 1)`);
    },
    async get(id) { const { rows } = await pool.query('SELECT payload FROM public.rpa_plan_scan_snapshots WHERE id=$1', [id]); return rows[0]?.payload || null; },
    async latest(readyOnly = false) {
      const { rows } = await pool.query(`SELECT payload FROM public.rpa_plan_scan_snapshots
        ${readyOnly ? "WHERE payload->>'state'='ready'" : ''} ORDER BY created_at DESC LIMIT 1`);
      return rows[0]?.payload || null;
    },
    async listWhitelist() {
      const { rows } = await pool.query(`SELECT w.task_id::text, w.schedule_uuid, w.field, t.task AS name,
        t.owner_user_id::text, w.created_by::text, w.created_at FROM public.rpa_plan_sync_whitelist w
        JOIN public.rpa_tasks t ON t.id=w.task_id WHERE t.deleted_at IS NULL AND t.schedule_uuid=w.schedule_uuid
        UNION ALL
        SELECT NULL::text AS task_id, p.schedule_uuid, 'plan' AS field, p.plan_name AS name,
          p.created_by::text AS owner_user_id, p.created_by::text, p.created_at
        FROM public.rpa_plan_creation_whitelist p
        ORDER BY created_at, task_id, field`);
      return rows;
    },
    async addRule(taskId, uuid, field, actor) {
      const { rowCount } = await pool.query(`INSERT INTO public.rpa_plan_sync_whitelist (task_id,schedule_uuid,field,created_by)
        SELECT id,schedule_uuid,$3,$4 FROM public.rpa_tasks WHERE id=$1 AND schedule_uuid=$2 AND deleted_at IS NULL
        AND (owner_user_id=$4 OR $5::boolean) ON CONFLICT DO NOTHING`, [taskId, uuid, field, actor.userId, actor.isAdmin]);
      return rowCount;
    },
    async removeRule(taskId, uuid, field, actor) {
      await pool.query(`DELETE FROM public.rpa_plan_sync_whitelist w USING public.rpa_tasks t
        WHERE w.task_id=$1 AND w.schedule_uuid=$2 AND w.field=$3 AND t.id=w.task_id
        AND (t.owner_user_id=$4 OR $5::boolean)`, [taskId, uuid, field, actor.userId, actor.isAdmin]);
    },
    async addPlanRule(uuid, name, actor) {
      await pool.query(`INSERT INTO public.rpa_plan_creation_whitelist (schedule_uuid,plan_name,created_by)
        SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM public.rpa_tasks WHERE schedule_uuid=$1 AND deleted_at IS NULL)
        ON CONFLICT DO NOTHING`, [uuid, name, actor.userId]);
    },
    async removePlanRule(uuid, actor) {
      return withTransaction(pool, async client => {
        const { rows } = await client.query('SELECT created_by::text FROM public.rpa_plan_creation_whitelist WHERE schedule_uuid=$1 FOR UPDATE', [uuid]);
        if (rows[0] && !actor.isAdmin && rows[0].created_by !== actor.userId) throw new AuthorizationError('只有加入白名单的人或管理员可以恢复此计划');
        await client.query('DELETE FROM public.rpa_plan_creation_whitelist WHERE schedule_uuid=$1', [uuid]);
      });
    },
    async removeRules(rules, actor) {
      return withTransaction(pool, async client => {
        const taskRules = rules.filter(rule => rule.field !== 'plan'), planRules = rules.filter(rule => rule.field === 'plan');
        const ids = [...new Set(taskRules.map(rule => rule.task_id))];
        const { rows } = await client.query('SELECT id::text, owner_user_id::text, schedule_uuid, deleted_at FROM public.rpa_tasks WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
        const current = new Map(rows.map(row => [row.id, row]));
        for (const rule of taskRules) {
          const task = current.get(rule.task_id);
          if (!task || task.deleted_at || (!actor.isAdmin && task.owner_user_id !== actor.userId)) throw new AuthorizationError('只有任务所有者或管理员可以修改白名单');
          if (task.schedule_uuid !== rule.schedule_uuid) throw new ConflictError('BINDING_CHANGED', '任务绑定已变化，请刷新白名单');
        }
        const plans = await client.query('SELECT schedule_uuid,created_by::text FROM public.rpa_plan_creation_whitelist WHERE schedule_uuid=ANY($1::text[]) ORDER BY schedule_uuid FOR UPDATE', [planRules.map(rule => rule.schedule_uuid)]);
        if (!actor.isAdmin && plans.rows.some(row => row.created_by !== actor.userId)) throw new AuthorizationError('只有加入白名单的人或管理员可以恢复此计划');
        await client.query(`DELETE FROM public.rpa_plan_sync_whitelist WHERE (task_id,schedule_uuid,field) IN
          (SELECT * FROM unnest($1::bigint[],$2::text[],$3::text[]))`,
        [taskRules.map(rule => rule.task_id), taskRules.map(rule => rule.schedule_uuid), taskRules.map(rule => rule.field)]);
        await client.query('DELETE FROM public.rpa_plan_creation_whitelist WHERE schedule_uuid=ANY($1::text[])', [planRules.map(rule => rule.schedule_uuid)]);
      });
    },
  };
}
module.exports = { createPlanReconciliationRepository };
