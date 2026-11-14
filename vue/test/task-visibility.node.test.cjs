const test = require('node:test');
const assert = require('node:assert/strict');
const { createTasksRepository } = require('../server/db/tasksRepository.cjs');
const { mapTaskRow } = require('../server/db/values.cjs');
const { presentTask } = require('../server/presenters.cjs');
function fixture(rows) {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT * FROM public.rpa_tasks')) return { rows };
    return { rows: [{ id: '1', is_hidden: true }] };
  }, release() {} };
  const pool = { connect: async () => client, query: client.query };
  return { calls, repository: createTasksRepository(pool) };
}
test('隐藏名单按事务锁行、审计，只更新展示字段，不修改排班和版本', async () => {
  const f = fixture([{ id: '1', is_hidden: false }]);
  await f.repository.setVisibility({ userId: '2', isAdmin: false }, [{ id: '1', expected_hidden: false, is_hidden: true }]);
  const update = f.calls.find(call => call.sql.startsWith('UPDATE'));
  assert.equal(update.sql, 'UPDATE public.rpa_tasks SET is_hidden=$2 WHERE id=$1');
  assert.deepEqual(update.params, ['1', true]);
  assert(f.calls.some(call => call.sql === 'COMMIT'));
  const audit = f.calls.find(call => call.sql.includes('INSERT INTO rpa_task_audit_log'));
  assert.equal(audit.params[1], '2');
  assert.equal(JSON.parse(audit.params[4]).scope, 'visibility');
  const history = f.calls.find(call => call.sql.includes('INSERT INTO public.rpa_task_operation_history'));
  assert.equal(JSON.parse(history.params[4]).is_hidden, false);
  assert.equal(JSON.parse(history.params[5]).is_hidden, true);
  assert.equal(JSON.parse(history.params[4]).operation_scope, 'visibility');
  assert(f.calls.some(call => call.sql.includes('DELETE FROM public.rpa_task_operation_history')));
});
test('任一任务冲突或已删除时整批拒绝，不产生部分写入', async () => {
  for (const rows of [[{ id: '1', is_hidden: true }, { id: '2', is_hidden: false }], [{ id: '1', is_hidden: false }]]) {
    const f = fixture(rows);
    await assert.rejects(() => f.repository.setVisibility({ userId: '1' }, ['1', '2'].map(id => ({ id, expected_hidden: false, is_hidden: true }))));
    assert(f.calls.some(call => call.sql === 'ROLLBACK'));
    assert(!f.calls.some(call => call.sql.startsWith('UPDATE')));
  }
});
test('隐藏标志穿过数据库映射与API呈现，旧数据默认false', () => {
  assert.equal(presentTask(mapTaskRow({ id: '1', is_hidden: true })).is_hidden, true);
  assert.equal(presentTask(mapTaskRow({ id: '1' })).is_hidden, false);
});
