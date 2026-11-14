const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduleReconciliation, differences } = require('../server/services/scheduleReconciliation.cjs');
const { createYingdaoClient } = require('../server/services/yingdaoClient.cjs');

const actor = { userId: '1', isAdmin: false };
const dispatch = { execute_scope: 'any', client_scope: 'assign', clients: [{ id: 'bot-a', name: 'A@tenant' }] };
const source = uuid => ({ scheduleUuid: uuid, scheduleName: `影刀${uuid}`, cronInterface: { type: 'day', hour: 23, minute: 50 }, executeScope: 'any', clientScope: 'assign', robotClientList: [{ uuid: 'bot-a', robotClientName: 'A@tenant' }] });
const task = (id, uuid) => ({ id, version: 1, task: `本地${uuid}`, schedule_uuid: uuid, owner: { id: '1', display_name: '甲' }, can_edit: true, bot: 'A', start: '09:00:00', finish: '09:30:00', tags: ['人工标签'], note: '保留备注', timing_mode: 'single', expected_duration_seconds: 1800, schedule_dispatch: dispatch });
function fixture() {
  let clock = 1000;
  const rows = [task('1', 'a'), task('2', 'gone')];
  const plans = new Map(['a', 'new', 'paused'].map(uuid => [uuid, source(uuid)]));
  const statuses = new Map(['a', 'new', 'paused'].map(uuid => [uuid, true]));
  let failList = false, stale = false;
  const calls = [];
  const client = {
    async getScheduleInventory() { if (failList) throw new Error('network'); return [...statuses].map(([schedule_uuid, enabled]) => ({ schedule_uuid, enabled })); },
    async getScheduleDetail(uuid) { return { schedule: plans.get(uuid) || null, cache: { stale, fetchedAt: '2026-11-05T00:00:00Z' } }; },
  };
  const snapshots = new Map(), rules = []; let locked = false;
  const stateRepository = {
    async acquireScanLock() { if (locked) return null; locked = true; return async () => { locked = false; }; },
    async withPolicyLock(fn) { return fn(); },
    async save(job) { snapshots.set(job.id, structuredClone({ ...job, applying: false })); },
    async get(id) { return structuredClone(snapshots.get(id) || null); },
    async latest(readyOnly = false) { return structuredClone([...snapshots.values()].reverse().find(job => !readyOnly || job.state === 'ready') || null); },
    async listWhitelist() { return rules; },
    async addRule(taskId, uuid, field, actor) { rules.push({ task_id: taskId, schedule_uuid: uuid, field, owner_user_id: actor.userId }); },
    async removeRule(taskId, uuid, field) { const i=rules.findIndex(rule => rule.task_id===taskId && rule.schedule_uuid===uuid && rule.field===field); if(i>=0)rules.splice(i,1); },
    async addPlanRule(uuid, name, actor) { rules.push({ task_id: null, schedule_uuid: uuid, field: 'plan', name, created_by: actor.userId, owner_user_id: actor.userId }); },
    async removePlanRule(uuid, actor) {
      const i = rules.findIndex(rule => rule.field === 'plan' && rule.schedule_uuid === uuid);
      if (i >= 0 && rules[i].created_by !== actor.userId && !actor.isAdmin) throw Object.assign(new Error('forbidden'), { status: 403 });
      if (i >= 0) rules.splice(i, 1);
    },
  };
  const service = createScheduleReconciliation({ client, stateRepository, now: () => clock,
    tasksRepository: { async listAll(userId, options) { return rows.map(row => ({...row, can_edit: row.can_edit && (String(row.owner?.id)===userId || options.currentUserIsAdmin)})); } },
    taskMutationService: { async applyBatch(...args) { calls.push(args); await args[2]?.beforeCommit?.({ query() {} }); return { tasks: [], id_map: {}, success: true }; } },
  });
  return { service, rows, plans, statuses, calls, stateRepository, rules, client, setFail: () => { failList = true; }, setStale: (value = true) => { stale = value; }, expire: () => { clock += 3600001; } };
}
async function scan(f) {
  const id = (await f.service.start(actor)).id;
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setImmediate(resolve));
    const view = await f.service.get(id, actor);
    if (view.state !== 'scanning') return view;
  }
  throw new Error('scan did not finish');
}
test('按UUID分类，未绑定停用计划忽略；扫描不写库，跨天同步保留原时长', async () => {
  const f = fixture(); f.statuses.set('paused', false);
  const result = await scan(f);
  assert.equal(result.state, 'ready');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(result.entries.map(e => e.kind).sort(), ['create', 'delete', 'update']);
  assert.equal(result.ignored, 1);
  const updated = result.entries.find(e => e.kind === 'update');
  assert.equal(updated.fields.find(e => e.field === 'finish').remote, '00:20:00');
  assert.equal(JSON.stringify(result).includes('sourceSignature'), false);
  await f.service.apply(result.id, actor, { entry_ids: [updated.id] });
  const mutation = f.calls[0][1].mutations[0];
  assert.equal(mutation.changes.finish, '00:20:00');
  assert.equal('tags' in mutation.changes, false);
  assert.equal('note' in mutation.changes, false);
  assert.equal('expected_duration_seconds' in mutation.changes, false);
  assert.equal(f.calls[0][2].syncPlans.get('1').dispatch.clients[0].id, 'bot-a');
  await assert.rejects(() => f.service.apply(result.id, actor, { entry_ids: [updated.id] }), { code: 'SCAN_CHANGED' });
});
test('分页失败完全不暴露可执行差异，详情旧缓存不会覆盖有效数据', async () => {
  const failed = fixture(); failed.setFail();
  const view = await scan(failed);
  assert.equal(view.state, 'failed');
  assert.equal(view.entries.length, 0);
  const stale = fixture(); stale.setStale();
  const staleView = await scan(stale);
  assert(staleView.entries.every(e => e.kind === 'error'));
  assert.equal(stale.calls.length, 0);
});
test('版本、影刀配置、缺失计划恢复、快照身份及有效期变化都阻止旧差异落库', async () => {
  for (const scenario of ['local', 'remote', 'restore']) {
    const f = fixture(), view = await scan(f);
    const entry = view.entries.find(e => e.kind === (scenario === 'restore' ? 'delete' : 'update'));
    if (scenario === 'local') f.rows[0].version++;
    if (scenario === 'remote') f.plans.get('a').scheduleName = 'changed';
    if (scenario === 'restore') f.plans.set('gone', source('gone'));
    await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [entry.id] }));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(), view = await scan(f);
  assert.equal((await f.service.get(view.id, { userId: '2' })).entries.find(e => e.kind === 'update').can_apply, false);
  f.expire();
  assert.equal((await f.service.get(view.id, actor)).state, 'ready');
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [view.entries.find(e => e.kind === 'update').id] }), { code: 'SCAN_EXPIRED' });
});
test('新增重新核验唯一绑定，客户端不能注入机器/UUID；写入使用服务器计划与人工时长', async () => {
  const f = fixture(), view = await scan(f), entry = view.entries.find(e => e.schedule_uuid === 'new');
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [entry.id], form: { task: '新建', expected_duration_seconds: 900, schedule_uuid: 'hijack' } }), { status: 400 });
  await f.service.apply(view.id, actor, { entry_ids: [entry.id], form: { task: '人工名称', tags: ['人工'], note: '备注', expected_duration_seconds: 900 } });
  assert.equal(f.calls[0][1].mutations[0].schedule_uuid, 'new');
  assert.equal(f.calls[0][1].mutations[0].finish, '00:05:00');
  assert.equal(f.calls[0][1].mutations[0].bot, 'A');
  const other = view.entries.find(e => e.schedule_uuid === 'paused');
  f.rows.push(task('3', 'paused'));
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [other.id], form: { task: 'name', expected_duration_seconds: 60 } }), { code: 'SCHEDULE_ALREADY_BOUND' });
});
test('差异执行失败不标记已处理；权限变化不可绕过', async () => {
  const f = fixture(), view = await scan(f), entry = view.entries.find(e => e.kind === 'update');
  f.rows[0].can_edit = false;
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [entry.id] }), { status: 403 });
  assert.equal((await f.service.get(view.id, actor)).entries.find(e => e.id === entry.id).applied, false);
});
test('机器顺序不产生差异，影刀规则和本地临时预览不按名称或机器误匹配', () => {
  const local = { ...task('1', 'a'), task: '影刀a', start: '23:50:00', finish: '00:20:00' };
  const remote = { schedule_name: '影刀a', defaults: { timing_mode: 'single', start: '23:50:00', expression: '' }, dispatch };
  assert.equal(differences(local, remote).fields.length, 0);
  const multi = { execute_scope: 'any', client_scope: 'assign', clients: [{ id: 'b', name: 'B' }, ...dispatch.clients] };
  local.schedule_dispatch = multi;
  remote.dispatch = { ...multi, clients: [...multi.clients].reverse() };
  assert.equal(differences(local, remote).fields.length, 0);
});
test('完整清单按启用/停用分别全量分页，重复页、缺页和总量变化均拒绝', async () => {
  const client = createYingdaoClient({ accessKeyId: 'test', accessKeySecret: 'test' });
  const calls = [];
  client.request = async (_path, body) => { calls.push(body); return { page: { page: body.page, total: 1, pages: 1 }, data: [{ scheduleUuid: body.enabled ? 'on' : 'off', scheduleName: '计划' }] }; };
  assert.equal((await client.getScheduleInventory()).length, 2);
  assert.deepEqual(calls.map(c => c.enabled), [true, false]);
  client.request = async () => ({ page: { page: 1, total: 2, pages: 1 }, data: [{ scheduleUuid: 'one' }] });
  await assert.rejects(() => client.getScheduleInventory());
  client.request = async () => ({ page: { page: 1, total: 2, pages: 1 }, data: [{ scheduleUuid: 'one' }, { scheduleUuid: 'one' }] });
  await assert.rejects(() => client.getScheduleInventory());
});

test('手动触发计划与本地未绑定任务不进入需人工处理，错误规则仍提醒', async () => {
  const f = fixture();
  f.plans.get('new').cronInterface = { type: 'manual' };
  f.plans.get('paused').cronInterface = { type: 'cron', cronExpress: 'invalid' };
  f.rows.push({ ...task('9', ''), schedule_uuid: null, owner: null });
  const view = await scan(f);
  assert.equal(view.ignored, 1);
  assert.equal(view.entries.some(entry => entry.schedule_uuid === 'new' || entry.task_id === '9'), false);
  assert.equal(view.entries.find(entry => entry.schedule_uuid === 'paused').kind, 'error');
});

test('共享白名单只忽略指定任务与绑定的属性；同步保留本地名称与指定时间', async () => {
  const f = fixture(), view = await scan(f), entry = view.entries.find(entry => entry.kind === 'update');
  await f.service.changeRule(actor, { task_id: '1', schedule_uuid: 'a', field: 'task' });
  await f.service.changeRule(actor, { task_id: '1', schedule_uuid: 'a', field: 'start' });
  assert.equal((await f.service.sharedState({ userId: '2' })).whitelist.length, 2);
  await f.service.apply(view.id, actor, { entry_ids: [entry.id] });
  const mutation = f.calls[0][1].mutations[0];
  assert.equal('task' in mutation.changes, false);
  assert.equal('start' in mutation.changes, false);
  assert.equal(mutation.changes.finish, '00:20:00');
});

test('白名单不能被客户端旧缓存绕过；无权限、错误绑定和属性不能修改规则', async () => {
  const f = fixture(), view = await scan(f), entry = view.entries.find(entry => entry.kind === 'update');
  await assert.rejects(() => f.service.changeRule({ userId: '2' }, { task_id: '1', schedule_uuid: 'a', field: 'task' }), { status: 403 });
  await assert.rejects(() => f.service.changeRule(actor, { task_id: '1', schedule_uuid: 'wrong', field: 'task' }), { code: 'BINDING_CHANGED' });
  await assert.rejects(() => f.service.changeRule(actor, { task_id: '1', schedule_uuid: 'a', field: 'owner_user_id' }), { status: 400 });
  for (const field of entry.fields) await f.service.changeRule(actor, { task_id: '1', schedule_uuid: 'a', field: field.field });
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [entry.id] }), { code: 'SCAN_CHANGED' });
  assert.equal(f.calls.length, 0);
  await f.service.changeRule(actor, { task_id: '1', schedule_uuid: 'a', field: 'task' }, true);
  await f.service.apply(view.id, actor, { entry_ids: [entry.id] });
  assert.deepEqual(f.calls[0][1].mutations[0].changes, { task: '影刀a' });
});

test('服务重建后数据库快照仍可读取和同步，跨账号读取不会继承扫描者权限', async () => {
  const f = fixture(), view = await scan(f);
  const restarted = createScheduleReconciliation({ client: f.client, stateRepository: f.stateRepository,
    tasksRepository: { async listAll(id, options) { return f.rows.map(row => ({ ...row, can_edit: row.can_edit && (row.owner?.id === id || options.currentUserIsAdmin) })); } },
    taskMutationService: { async applyBatch(...args) { f.calls.push(args); await args[2]?.beforeCommit?.({ query() {} }); return { success: true }; } }, now: () => 1000 });
  const originalInventory = f.client.getScheduleInventory;
  f.client.getScheduleInventory = async () => { throw new Error('view must not rescan'); };
  const shared = await restarted.sharedState({ userId: '2' });
  assert.equal(shared.result.id, view.id);
  const entry = shared.result.entries.find(entry => entry.kind === 'update');
  assert.equal(entry.can_apply, false);
  await assert.rejects(() => restarted.apply(view.id, { userId: '2' }, { entry_ids: [entry.id] }), { status: 403 });
  f.client.getScheduleInventory = originalInventory;
  await restarted.apply(view.id, actor, { entry_ids: [entry.id] });
  assert.equal(f.calls.length, 1);
});

test('一键新增按最近最大耗时取整并处理跨天，无记录使用确认的1分钟默认值', async () => {
  const f = fixture(), view = await scan(f), entries = view.entries.filter(entry => entry.kind === 'create');
  f.client.listRecentTasks = async uuid => uuid === 'new' ? [{ taskUuid: 'short', status: 'finish' }, { taskUuid: 'long', status: 'finish' }] : [];
  f.client.queryTask = async uuid => ({ execution: { taskUuid: uuid, status: 'finish', startTime: '2026-11-06 10:00:00', endTime: uuid === 'short' ? '2026-11-06 10:01:01' : '2026-11-06 10:10:01', jobDataList: [{ jobUuid: `job-${uuid}`, status: 'finish', robotClientUuid: 'client', robotUuid: 'app' }] } });
  f.client.getTaskProcessDetail = async uuid => ({ jobs: [{ taskUuid: uuid, jobUuid: `job-${uuid}`, status: 'finish', robotClientUuid: 'client', robotUuid: 'app', dispatchCount: 1 }] });
  const result = await f.service.apply(view.id, actor, { entry_ids: entries.map(entry => entry.id), bulk_create: true });
  assert.equal(f.calls.length, 1);
  const mutations = f.calls[0][1].mutations;
  assert.equal(mutations.length, 2);
  const first = mutations.find(row => row.schedule_uuid === 'new'), second = mutations.find(row => row.schedule_uuid === 'paused');
  assert.equal(first.task, '影刀new');
  assert.equal(first.expected_duration_seconds, 660);
  assert.equal(first.finish, '00:01:00');
  assert.deepEqual(first.tags, ['每日']);
  assert.equal(second.expected_duration_seconds, 60);
  assert.equal(result.duration_fallback_count, 1);
  assert.equal((await f.service.get(view.id, actor)).entries.filter(entry => entry.kind === 'create').every(entry => entry.applied), true);
});

test('批量新增拒绝混入更新、客户端表单，历史读取失败和影刀变化均不写任务', async () => {
  const f = fixture(), view = await scan(f), creates = view.entries.filter(entry => entry.kind === 'create');
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [creates[0].id, view.entries.find(entry => entry.kind === 'update').id], bulk_create: true }), { status: 400 });
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: creates.map(entry => entry.id), bulk_create: true, form: { task: '注入' } }), { status: 400 });
  f.client.listRecentTasks = async () => { throw new Error('history unavailable'); };
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: creates.map(entry => entry.id), bulk_create: true }));
  assert.equal(f.calls.length, 0);
  f.client.listRecentTasks = async () => [];
  f.plans.get('paused').scheduleName = 'changed';
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: creates.map(entry => entry.id), bulk_create: true }), { code: 'UPSTREAM_CHANGED' });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.get(view.id, actor)).entries.some(entry => entry.applied), false);
});

test('只重新核验所选异常详情，并读取清单确认启用状态，不处理其他异常或修改任务', async () => {
  const f = fixture(); f.setStale();
  const view = await scan(f), entry = view.entries.find(entry => entry.schedule_uuid === 'new');
  assert.equal(entry.kind, 'error');
  f.setStale(false);
  const state = await f.service.recheck(view.id, { userId: '2' }, [entry.id]);
  assert.equal(state.result.entries.find(row => row.id === entry.id).kind, 'create');
  assert.equal(state.result.entries.filter(row => row.kind === 'error').length, 3);
  assert.equal(state.result.scanned_at, view.scanned_at);
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => f.service.recheck(view.id, actor, [entry.id]), { status: 400 });
});

test('重新核验可忽略修正为手动触发的记录，不推断删除；过期快照要求重扫', async () => {
  const f = fixture(); f.plans.get('new').cronInterface = { type: 'cron', cronExpress: 'invalid' };
  const view = await scan(f), entry = view.entries.find(entry => entry.schedule_uuid === 'new');
  f.plans.get('new').cronInterface = { type: 'manual' };
  const state = await f.service.recheck(view.id, actor, [entry.id]);
  assert.equal(state.result.entries.some(row => row.id === entry.id), false);
  assert.equal(state.result.ignored, 1);
  f.expire();
  await assert.rejects(() => f.service.recheck(view.id, actor, [entry.id]), { code: 'SCAN_EXPIRED' });
  assert.equal(f.calls.length, 0);
});

test('待新增按计划加入共享白名单，旧缓存或直接提交也不能创建被忽略计划，恢复后可新增', async () => {
  const f = fixture(), view = await scan(f), entry = view.entries.find(entry => entry.schedule_uuid === 'new');
  const rule = { task_id: null, schedule_uuid: 'new', field: 'plan' };
  await f.service.changeRule(actor, rule);
  assert.equal((await f.service.sharedState({ userId: '2' })).whitelist[0].can_edit, false);
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [entry.id], bulk_create: true }), { code: 'PLAN_IGNORED' });
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [entry.id], form: { task: '人工', expected_duration_seconds: 60 } }), { code: 'PLAN_IGNORED' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => f.service.changeRule({ userId: '2' }, rule, true), { status: 403 });
  await f.service.changeRule(actor, rule, true);
  await f.service.apply(view.id, actor, { entry_ids: [entry.id], form: { task: '新增', expected_duration_seconds: 60 } });
  assert.equal(f.calls.length, 1);
});

test('计划新增白名单不抑制已绑定任务的更新，不能伪造为任务属性规则', async () => {
  const f = fixture(), view = await scan(f), entry = view.entries.find(entry => entry.schedule_uuid === 'a');
  await assert.rejects(() => f.service.changeRule(actor, { task_id: '1', schedule_uuid: 'a', field: 'plan' }), { status: 400 });
  await assert.rejects(() => f.service.changeRule(actor, { task_id: null, schedule_uuid: 'a', field: 'plan' }), { code: 'SCHEDULE_ALREADY_BOUND' });
  f.rules.push({ task_id: null, schedule_uuid: 'a', field: 'plan' });
  await f.service.apply(view.id, actor, { entry_ids: [entry.id] });
  assert.equal(f.calls[0][1].mutations[0].type, 'update');
});

test('影刀月末L计划正常进入新增与设置变化，不再进入需人工处理，缓存表达式原样保留', async () => {
  const f = fixture();
  f.plans.get('a').cronInterface = { type: 'cron', cronExpress: '0 22 L * *' };
  f.plans.get('new').cronInterface = { type: 'cron', cronExpress: '0 22 L * *' };
  const result = await scan(f);
  const update = result.entries.find(entry => entry.schedule_uuid === 'a');
  const create = result.entries.find(entry => entry.schedule_uuid === 'new');
  assert.equal(update.kind, 'update');
  assert.equal(create.kind, 'create');
  assert.deepEqual(create.defaults.tags, ['每月']);
  assert.equal(create.defaults.start, '22:00:00');
  await f.service.apply(result.id, actor, { entry_ids: [update.id] });
  assert.equal(f.calls[0][2].syncPlans.get('1').expression, '0 22 L * *');
});

test('已绑定停用计划进入待删除，确认只软删除本地任务', async () => {
  const f = fixture(); f.rows.push(task('3', 'paused')); f.statuses.set('paused', false);
  f.plans.get('paused').cronInterface = { type: 'cron', cronExpress: 'invalid' };
  const view = await scan(f), entry = view.entries.find(row => row.schedule_uuid === 'paused');
  assert.equal(entry.kind, 'delete'); assert.equal(entry.delete_reason, 'disabled');
  assert.match(entry.warning, /已停用/);
  await f.service.apply(view.id, actor, { entry_ids: [entry.id] });
  assert.deepEqual(f.calls[0][1].mutations, [{ type: 'delete', id: '3', version: 1 }]);
});

test('待删除停用计划重新启用、待新增启用计划变停用均阻止旧缓存执行', async () => {
  const f = fixture(); f.rows.push(task('3', 'paused')); f.statuses.set('paused', false);
  const view = await scan(f), deletion = view.entries.find(row => row.schedule_uuid === 'paused');
  f.statuses.set('paused', true);
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [deletion.id] }), { code: 'UPSTREAM_CHANGED' });
  const creation = view.entries.find(row => row.schedule_uuid === 'new'); f.statuses.set('new', false);
  await assert.rejects(() => f.service.apply(view.id, actor, { entry_ids: [creation.id], bulk_create: true }), { code: 'UPSTREAM_CHANGED' });
  assert.equal(f.calls.length, 0);
});

test('重新核验异常时，停用且未绑定忽略，已绑定转待删除', async () => {
  const f = fixture(); f.setStale(); const view = await scan(f); f.setStale(false);
  f.statuses.set('new', false); f.statuses.set('a', false);
  const selected = view.entries.filter(row => ['new', 'a'].includes(row.schedule_uuid));
  const state = await f.service.recheck(view.id, actor, selected.map(row => row.id));
  assert.equal(state.result.entries.some(row => row.schedule_uuid === 'new'), false);
  assert.equal(state.result.entries.find(row => row.schedule_uuid === 'a').delete_reason, 'disabled');
  assert.equal(f.calls.length, 0);
});

test('旧扫描缓存中的停用待新增条目也不再展示', () => {
  const { visibleEntries } = require('../shared/reconciliationPolicy.mjs');
  const rows = [{ id: 'off', kind: 'create', enabled: false }, { id: 'on', kind: 'create', enabled: true }, { id: 'delete', kind: 'delete', enabled: false }];
  assert.deepEqual(visibleEntries(rows, []).map(row => row.id), ['on', 'delete']);
});

test('扫描结果与任务落库共用事务，快照写入失败不把差异标成已应用', async () => {
  const f = fixture(), view = await scan(f), entry = view.entries.find(row => row.kind === 'update');
  const originalSave = f.stateRepository.save;
  let receivedExecutor;
  f.stateRepository.save = async (job, options) => {
    receivedExecutor = options?.executor;
    if (job.entries.some(row => row.applied)) throw new Error('snapshot unavailable');
    return originalSave(job);
  };
  await assert.rejects(f.service.apply(view.id, actor, { entry_ids: [entry.id] }), /snapshot unavailable/);
  assert.equal(typeof receivedExecutor.query, 'function');
  assert.equal((await f.service.get(view.id, actor)).entries.find(row => row.id === entry.id).applied, false);
  f.stateRepository.save = originalSave;
  await f.service.apply(view.id, actor, { entry_ids: [entry.id] });
  assert.equal((await f.service.get(view.id, actor)).entries.find(row => row.id === entry.id).applied, true);
});
test('运行详情接口故障阻止一键新增，不得用无记录的一分钟默认值代替', async () => {
  const f = fixture(), view = await scan(f), entries = view.entries.filter(row => row.kind === 'create');
  f.client.listRecentTasks = async () => [{ taskUuid: 'fake-run', status: 'finish' }];
  f.client.queryTask = async () => { throw new Error('upstream unavailable'); };
  await assert.rejects(f.service.apply(view.id, actor, { entry_ids: entries.map(row => row.id), bulk_create: true }), { code: 'RUN_HISTORY_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});
