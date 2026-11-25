const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskHistoryRepository, taskSnapshot, appendTaskHistory } = require('../server/db/taskHistoryRepository.cjs');
const { createTaskHistoryService } = require('../server/services/taskHistoryService.cjs');

function harness(options = {}) {
  const original = {
    id: '1', task: '原任务', start_time: '23:30:00', finish_time: '01:15:00', bot: 'A',
    tags: ['每日'], note: '原备注', owner_user_id: '7', schedule_uuid: 'old-plan',
    schedule_bound_at: new Date('2026-10-01T00:00:00Z'), deleted_at: null, version: 1,
  };
  let state = {
    tasks: new Map([
      ['1', { ...original, task: '后来改名', start_time: '09:00:00', owner_user_id: '8', schedule_uuid: 'new-plan', version: 4, ...options.current }],
      ['2', { ...original, id: '2', task: '其他任务', schedule_uuid: 'other-plan' }],
    ]),
    histories: new Map([['10', {
      id: '10', task_id: '1', task_name: original.task, actor_user_id: '7', action: 'update',
      audit_log_id: '41', before_snapshot: taskSnapshot(original), after_snapshot: taskSnapshot(original),
      snapshot_complete: true, annotation: '', annotation_version: 0, reverted_by_audit_id: null,
      ...options.history,
    }]]),
    audits: [{ id: '41' }], bindings: [],
  };
  let nextHistory = 100;
  let nextAudit = 50;
  let lockCount = 0;
  let remoteChecks = 0;
  const activeUsers = options.activeUsers || ['7', '8'];

  async function execute(target, sql, p = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (text.startsWith('SELECT * FROM public.rpa_task_operation_history')) {
      const row = target.histories.get(String(p[0]));
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (text.startsWith('SELECT * FROM public.rpa_tasks')) {
      if (text.endsWith('FOR UPDATE')) lockCount += 1;
      const row = target.tasks.get(String(p[0]));
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (text.startsWith('SELECT id FROM public.app_users')) return { rows: activeUsers.includes(String(p[0])) ? [{ id: p[0] }] : [] };
    if (text.startsWith('SELECT id, display_name FROM')) return { rows: p[0].map(id => ({ id, display_name: `用户 ${id}` })) };
    if (text.startsWith('SELECT 1 FROM public.rpa_task_executions')) return { rows: options.active || options.pending ? [{ '?column?': 1 }] : [] };
    if (text.startsWith('SELECT MAX(')) return { rows: [{ last_boundary: original.schedule_bound_at }] };
    if (text.startsWith('UPDATE public.rpa_task_binding_history')) {
      target.bindings.push({ closed_task: String(p[0]), at: p[1] });
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO public.rpa_task_binding_history')) {
      if (options.lateOccupation) throw Object.assign(new Error('occupied'), { code: '23505', constraint: 'uq_schedule' });
      target.bindings.push({ task_id: String(p[0]), schedule_uuid: p[1], bound_at: p[2] });
      return { rows: [] };
    }
    if (text.startsWith('UPDATE public.rpa_tasks SET task')) {
      const row = target.tasks.get(String(p[0]));
      if (row.version !== p[13]) return { rows: [] };
      Object.assign(row, { task: p[1], start_time: p[2], finish_time: p[3], bot: p[4], tags: p[5], note: p[6],
        owner_user_id: p[7], schedule_uuid: p[8], schedule_bound_at: p[9], deleted_at: p[10], version: row.version + 1, is_hidden: p[16] });
      return { rows: [structuredClone(row)] };
    }
    if (text.startsWith('UPDATE public.rpa_tasks SET is_hidden')) {
      const row = target.tasks.get(String(p[0]));
      row.is_hidden = p[1];
      return { rows: [structuredClone(row)] };
    }
    if (text.startsWith('INSERT INTO rpa_task_audit_log')) {
      const row = { id: String(nextAudit++), task_id: String(p[0]), action: p[2], new_value: JSON.parse(p[4]) };
      target.audits.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('UPDATE public.rpa_task_operation_history SET reverted_by')) {
      for (const row of target.histories.values()) if (row.audit_log_id === String(p[0]) && row.task_id === String(p[2])) row.reverted_by_audit_id = String(p[1]);
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO public.rpa_task_operation_history')) {
      if (options.failHistory) throw new Error('history write failed');
      const id = String(nextHistory++);
      target.histories.set(id, { id, audit_log_id: String(p[0]), task_id: String(p[1]), actor_user_id: String(p[2]), action: p[3],
        before_snapshot: JSON.parse(p[4]), after_snapshot: JSON.parse(p[5]), snapshot_complete: p[6], source_audit_id: p[9] });
      return { rows: [] };
    }
    if (text.startsWith('DELETE FROM public.rpa_task_operation_history')) {
      const rows = [...target.histories.values()].filter(row => row.task_id === String(p[0])).sort((a, b) => Number(b.id) - Number(a.id));
      for (const row of rows.slice(p[1])) target.histories.delete(row.id);
      return { rows: [] };
    }
    if (text.startsWith('UPDATE public.rpa_task_operation_history SET annotation')) {
      const row = target.histories.get(String(p[0]));
      if (!row || row.actor_user_id !== p[1] || row.annotation_version !== p[3]) return { rows: [] };
      row.annotation = p[2]; row.annotation_version += 1;
      return { rows: [{ annotation: row.annotation, annotation_version: row.annotation_version }] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }
  const pool = {
    query: (sql, p) => execute(state, sql, p),
    async connect() {
      let transaction;
      return {
        async query(sql, p) {
          if (sql === 'BEGIN') { transaction = structuredClone(state); return { rows: [] }; }
          if (sql === 'COMMIT') { state = transaction; return { rows: [] }; }
          if (sql === 'ROLLBACK') return { rows: [] };
          return execute(transaction, sql, p);
        },
        release() {},
      };
    },
  };
  const repository = createTaskHistoryRepository(pool);
  const service = createTaskHistoryService({ pool, historyRepository: repository, scheduleDirectory: {
    async assertBindable() {
      remoteChecks += 1;
      if (options.remoteError) throw options.remoteError;
    },
  } });
  return { service, pool, original, state: () => state, lockCount: () => lockCount, remoteChecks: () => remoteChecks };
}

test('较早记录恢复完整配置、原所有者和旧计划，其他任务与原审计保留', async () => {
  const h = harness();
  const other = structuredClone(h.state().tasks.get('2'));
  const preview = await h.service.preview('8', '10');
  assert.equal(preview.task_version, 4);
  assert.equal(preview.target.owner_user_id, '7');
  const result = await h.service.restore('8', '10', preview.task_version);
  const current = h.state().tasks.get('1');
  assert.equal(result.version, 5);
  assert.deepEqual(taskSnapshot(current), taskSnapshot(h.original));
  assert.ok(current.schedule_bound_at > h.original.schedule_bound_at);
  assert.deepEqual(h.state().tasks.get('2'), other);
  assert.equal(h.state().audits[0].id, '41');
  assert.equal(h.state().audits.at(-1).action, 'restore');
  assert.equal(h.state().histories.get('10').reverted_by_audit_id, result.audit_id);
  assert.equal(h.lockCount(), 1);
});

test('旧操作人失去任务所有权后不能还原；当前所有者与管理员可以', async () => {
  const h = harness();
  await assert.rejects(h.service.preview('7', '10'), e => e.status === 403);
  assert.equal(h.remoteChecks(), 0);
  await h.service.preview({ userId: '9', isAdmin: true }, '10');
});

test('重复还原、版本冲突、旧快照不完整、立即执行记录均被拒绝', async () => {
  const h = harness();
  await assert.rejects(h.service.restore('8', '10', 3), e => e.code === 'VERSION_CONFLICT');
  await h.service.restore('8', '10', 4);
  await assert.rejects(h.service.restore('7', '10', 5), e => e.code === 'HISTORY_ALREADY_RESTORED');
  for (const history of [{ snapshot_complete: false }, { action: 'run_now' }, { before_snapshot: { task: 'partial' } }]) {
    await assert.rejects(harness({ history }).service.preview('8', '10'), e => /HISTORY_/.test(e.code));
  }
});

test('非操作人不能修改备注；操作人可以修改且检查备注版本，不占历史条数', async () => {
  const h = harness();
  await assert.rejects(h.service.annotate('8', '10', { annotation: 'x', version: 0 }), e => e.status === 403);
  const result = await h.service.annotate('7', '10', { annotation: '7:30 前没数据', version: 0 });
  assert.equal(result.annotation_version, 1);
  assert.equal(h.state().histories.size, 1);
  await assert.rejects(h.service.annotate('7', '10', { annotation: '旧窗口覆盖', version: 0 }), e => e.code === 'ANNOTATION_CONFLICT');
});

test('原所有者停用、活动执行或待发送请求阻止绑定还原', async () => {
  for (const options of [{ activeUsers: ['8'] }, { active: true }, { pending: true }]) {
    const h = harness(options);
    await assert.rejects(h.service.restore('8', '10', 4), e => ['RESTORE_OWNER_INACTIVE', 'TASK_ALREADY_ACTIVE'].includes(e.code));
    assert.equal(h.state().tasks.get('1').version, 4);
  }
});

test('远端校验失败不写数据，事务内计划抢占或历史写入失败全部回滚', async () => {
  for (const options of [{ remoteError: new Error('upstream failed') }, { lateOccupation: true }, { failHistory: true }]) {
    const h = harness(options);
    const before = structuredClone(h.state());
    await assert.rejects(h.service.restore('8', '10', 4));
    assert.deepEqual(h.state(), before);
  }
});

test('还原新增或导入只软删除这一个任务；还原删除恢复相同 ID', async () => {
  for (const action of ['create', 'import']) {
    const h = harness({ history: { action, before_snapshot: null } });
    await h.service.restore('8', '10', 4);
    assert.ok(h.state().tasks.get('1').deleted_at);
    assert.equal(h.state().tasks.get('1').schedule_uuid, null);
    assert.equal(h.state().tasks.get('2').deleted_at, null);
  }
  const h = harness({ history: { action: 'delete' }, current: { deleted_at: new Date(), schedule_uuid: null, schedule_bound_at: null } });
  await h.service.restore('8', '10', 4);
  assert.equal(h.state().tasks.get('1').id, '1');
  assert.equal(h.state().tasks.get('1').deleted_at, null);
});

test('恢复到历史只读状态仅管理员可操作', async () => {
  const h = harness();
  Object.assign(h.state().histories.get('10'), { before_snapshot: { ...taskSnapshot(h.original), owner_user_id: null, schedule_uuid: null, bound: false } });
  await assert.rejects(h.service.restore('8', '10', 4), e => e.code === 'ADMIN_REQUIRED');
  await h.service.restore({ userId: '9', isAdmin: true }, '10', 4);
  assert.equal(h.state().tasks.get('1').owner_user_id, null);
  assert.equal(h.state().tasks.get('1').schedule_uuid, null);
});

test('每个任务单独保留 50 条，清理不删除原审计；被清理记录不可还原', async () => {
  const h = harness();
  await appendTaskHistory(h.pool, { auditId: '99', taskId: '2', actorUserId: '7', action: 'update', beforeTask: h.original, afterTask: h.original });
  for (let i = 0; i < 55; i += 1) await appendTaskHistory(h.pool, { auditId: String(1000 + i), taskId: '1', actorUserId: '7', action: 'update', beforeTask: h.original, afterTask: h.original });
  assert.equal([...h.state().histories.values()].filter(row => row.task_id === '1').length, 50);
  assert.equal([...h.state().histories.values()].filter(row => row.task_id === '2').length, 1);
  assert.equal(h.state().audits[0].id, '41');
  await assert.rejects(h.service.preview('8', '10'), e => e.status === 404);
});

function visibilityHarness(options = {}) {
  const h = harness({ current: { is_hidden: true, ...options.current }, activeUsers: [], remoteError: new Error('must not contact Yingdao'), ...options });
  const before = { ...taskSnapshot(h.original), is_hidden: false, operation_scope: 'visibility' };
  Object.assign(h.state().histories.get('10'), { before_snapshot: before, after_snapshot: { ...before, is_hidden: true } });
  return h;
}
test('仅管理员可以还原隐藏状态，保留后来修改的配置、所有者、绑定与版本，不请求影刀', async () => {
  const h = visibilityHarness();
  const current = structuredClone(h.state().tasks.get('1'));
  const other = structuredClone(h.state().tasks.get('2'));
  const preview = await h.service.preview({ userId: '99', isAdmin: true }, '10');
  assert.equal(preview.visibility_only, true);
  assert.deepEqual(preview.changes, ['is_hidden']);
  await h.service.restore({ userId: '99', isAdmin: true }, '10', 4);
  assert.deepEqual(h.state().tasks.get('1'), { ...current, is_hidden: false });
  assert.deepEqual(h.state().tasks.get('2'), other);
  assert.equal(h.remoteChecks(), 0);
  assert.equal(h.state().histories.get('100').before_snapshot.operation_scope, 'visibility');
  await assert.rejects(h.service.restore({ userId: '99', isAdmin: true }, '10', 4), { code: 'HISTORY_ALREADY_RESTORED' });
  // Restoring the restore changes only visibility again.
  await h.service.restore({ userId: '98', isAdmin: true }, '100', 4);
  assert.deepEqual(h.state().tasks.get('1'), current);
});
test('隐藏记录还原失败整笔回滚；伪装为隐藏操作的配置变更仍检查所有权', async () => {
  const h = visibilityHarness({ failHistory: true });
  await assert.rejects(h.service.restore({ userId: '99', isAdmin: true }, '10', 4));
  assert.equal(h.state().tasks.get('1').is_hidden, true);
  assert.equal(h.state().histories.get('10').reverted_by_audit_id, null);
  const forged = visibilityHarness();
  forged.state().histories.get('10').after_snapshot.task = 'changed';
  await assert.rejects(forged.service.preview('99', '10'), { status: 403 });
  const deleted = visibilityHarness({ current: { deleted_at: new Date() } });
  await assert.rejects(deleted.service.preview({ userId: '99', isAdmin: true }, '10'), { code: 'TASK_DELETED' });
});
test('旧快照未包含隐藏标志时，还原配置保留当前隐藏选择', async () => {
  const h = harness({ current: { is_hidden: true } });
  delete h.state().histories.get('10').before_snapshot.is_hidden;
  await h.service.restore('8', '10', 4);
  assert.equal(h.state().tasks.get('1').is_hidden, true);
});

test('普通任务所有者不可预览或还原隐藏记录，普通配置还原不能间接改变隐藏标志', async () => {
  const h = visibilityHarness();
  await assert.rejects(h.service.preview('8', '10'), { code: 'ADMIN_REQUIRED' });
  await assert.rejects(h.service.restore('8', '10', 4), { code: 'ADMIN_REQUIRED' });
  assert.equal(h.state().tasks.get('1').is_hidden, true);
  const normal = harness({ current: { is_hidden: true } });
  const preview = await normal.service.preview('8', '10');
  assert.equal(preview.target.is_hidden, true);
  await normal.service.restore('8', '10', 4);
  assert.equal(normal.state().tasks.get('1').is_hidden, true);
  assert.equal(normal.state().tasks.get('1').task, '原任务');
});

test('隐藏记录列表不给普通所有者还原按钮，管理员保留还原能力', async () => {
  const h = visibilityHarness();
  const row = { ...h.state().histories.get('10'), current_owner_id: '8', current_deleted_at: null };
  const repository = createTaskHistoryRepository({ query: async sql => sql.includes('COUNT(*)')
    ? { rows: [{ retained_count: 1, today_count: 1 }] } : { rows: [row] } });
  const user = await repository.list({ userId: '8', isAdmin: false }, { limit: 10 });
  const admin = await repository.list({ userId: '99', isAdmin: true }, { limit: 10 });
  assert.equal(user.records[0].can_restore, false);
  assert.equal(admin.records[0].can_restore, true);
});
