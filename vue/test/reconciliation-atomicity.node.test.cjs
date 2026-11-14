const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskMutationService } = require('../server/services/taskMutationService.cjs');
const { createPlanReconciliationRepository } = require('../server/db/planReconciliationRepository.cjs');

test('快照写入失败时回滚任务和审计；重试成功只提交一次，快照使用同一事务连接', async () => {
  let saved = { note: 'before', auditCount: 0, historyCount: 0, applied: false }, transaction, failSnapshot = true;
  const commands = [];
  const row = () => ({ id: '1', task: '任务', start_time: '09:00:00', finish_time: '09:30:00',
    bot: 'A', owner_user_id: '7', schedule_uuid: 'plan', schedule_bound_at: '2026-11-01T00:00:00Z',
    version: 1, tags: [], note: transaction.note });
  const client = {
    release() {},
    async query(sql, params) {
      const text = sql.replace(/\s+/g, ' ').trim();
      commands.push(text);
      if (text === 'BEGIN') { transaction = structuredClone(saved); return { rows: [] }; }
      if (text === 'COMMIT') { saved = transaction; return { rows: [] }; }
      if (text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('SELECT * FROM rpa_tasks')) return { rows: [row()] };
      if (text.startsWith('UPDATE rpa_tasks')) { transaction.note = params[2]; return { rows: [row()] }; }
      if (text.startsWith('INSERT INTO rpa_task_audit_log')) { transaction.auditCount++; return { rows: [{ id: '1' }] }; }
      if (text.startsWith('INSERT INTO public.rpa_task_operation_history')) transaction.historyCount++;
      if (text.startsWith('INSERT INTO public.rpa_plan_scan_snapshots')) {
        if (failSnapshot) throw new Error('snapshot write failed');
        transaction.applied = JSON.parse(params[1]).entries[0].applied;
      }
      return { rows: [] };
    },
  };
  const pool = { connect: async () => client, query: async () => { throw new Error('must use transaction executor'); } };
  const mutations = createTaskMutationService({ pool, scheduleDirectory: {} });
  const snapshots = createPlanReconciliationRepository(pool);
  const body = { mutations: [{ type: 'update', id: '1', version: 1, changes: { note: 'after' } }] };
  const beforeCommit = executor => snapshots.save({ id: 'scan', entries: [{ applied: true }] }, { executor });
  await assert.rejects(mutations.applyBatch('7', body, { beforeCommit }), /snapshot write failed/);
  assert.deepEqual(saved, { note: 'before', auditCount: 0, historyCount: 0, applied: false });
  assert.equal(commands.at(-1), 'ROLLBACK');
  failSnapshot = false;
  await mutations.applyBatch('7', body, { beforeCommit });
  assert.deepEqual(saved, { note: 'after', auditCount: 1, historyCount: 1, applied: true });
  assert.equal(commands.filter(text => text === 'COMMIT').length, 1);
});
