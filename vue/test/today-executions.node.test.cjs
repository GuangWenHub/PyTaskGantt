const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYingdaoJson, normalizePage } = require('../server/services/yingdaoClient.cjs');
const { readToday, createTodayExecutions, todayWindow, clientIds } = require('../server/services/todayExecutions.cjs');
const from = new Date('2026-11-13T00:00:00+08:00'), to = new Date('2026-11-14T00:00:00+08:00');
const record = (id, time, extra = {}) => ({ taskUuid: id, sourceUuid: 'plan', createTime: `2026-11-13 ${time}`, status: 'finish', ...extra });
test('最新记录result/pageDTO被正常读取，分页BIGINT无精度损失，字符串内容不被改写', () => {
  const raw = parseYingdaoJson('{"data":{"pageDTO":{"page":1,"pages":2},"result":[{"taskUuid":"a","id":2120577365733175301}]},"nextId":2120577365733175301,"text":"x \\"id\\":2120577365733175301","float":1.5}');
  const page = normalizePage(raw);
  assert.equal(page.items.length, 1); assert.equal(page.page.pages, 2);
  assert.equal(raw.nextId, '2120577365733175301'); assert.equal(page.items[0].id, raw.nextId);
  assert.equal(raw.text, 'x "id":2120577365733175301'); assert.equal(raw.float, 1.5);
});
test('今日历史完整翻页、保留重试成功和异常，遇到昨日停止，精确传递大整数游标', async () => {
  const calls = [];
  const client = { async request(path, input) {
    calls.push(input);
    return calls.length === 1 ? { data: { dataList: [record('new', '12:00:00', { remark: '重试后成功' })], nextId: '2120577365733175301', hasData: true } }
      : { data: { dataList: [record('old', '02:00:00', { status: 'error' }), record('yesterday', '00:00:00', { createTime: '2026-11-12 23:00:00' })], nextId: '2', hasData: true } };
  } };
  const result = await readToday(client, 'plan', from, to);
  assert.deepEqual(result.map(row => row.taskUuid), ['new', 'old']);
  assert.equal(calls.length, 2); assert.equal(calls[1].cursorId, '2120577365733175301');
});
test('缺页、重复记录或错误绑定拒绝报告读取完整', async () => {
  for (const body of [{ data: {} }, { data: { dataList: [record('a', '12:00:00')], hasData: true } },
    { data: { dataList: [record('a', '12:00:00'), record('a', '12:00:00')], hasData: false } },
    { data: { dataList: [record('a', '12:00:00', { sourceUuid: 'other' })], hasData: false } }]) {
    await assert.rejects(() => readToday({ request: async () => body }, 'plan', from, to));
  }
});
test('上海日期边界及实际机器读取不依赖服务器时区', () => {
  assert.equal(todayWindow(Date.parse('2026-11-12T16:01:00Z')).date, '2026-11-13');
  assert.equal(todayWindow(Date.parse('2026-11-13T15:59:59Z')).from.toISOString(), '2026-11-12T16:00:00.000Z');
  assert.deepEqual(clientIds([{ robotClientUuid: 'a' }, { robotClientUuid: 'a' }, { currentRobotUuid: 'app-id' }]), ['a']);
});
test('批量只读接口共享后台补齐与一分钟缓存，不跨任务绑定，错误不冒充未运行', async () => {
  let clock = Date.parse('2026-11-13T04:00:00Z'), requests = 0;
  const applied = [], sql = [];
  const task = { id: '1', scheduleUuid: 'plan', scheduleBoundAt: from.toISOString() };
  const client = { async request() { requests++; return { data: { dataList: [record('a', '10:00:00')], hasData: false } }; } };
  const service = createTodayExecutions({ client, now: () => clock, tasksRepository: { listAll: async () => [task] },
    syncCoordinator: { applyRecords: async (...args) => { applied.push(args); } }, pool: { query: async (text, params) => { sql.push({ text, params }); return { rows: [] }; } }, logger: { warn() {} } });
  await service.read({ userId: '1' }, ['1']); await service.wait();
  const result = await service.read({ userId: '2' }, ['1']);
  assert.equal(requests, 1); assert.equal(result.tasks[0].state, 'ready');
  assert.deepEqual(applied[0][1].boundTasks, [task]);
  assert.match(sql[0].text, /e\.schedule_uuid_at_run=t\.schedule_uuid/);
  assert.match(sql[0].text, /e\.trigger_time>=t\.schedule_bound_at/);
  clock += 61000; client.request = async () => { throw new Error('private detail'); };
  await service.read({ userId: '1' }, ['1']); await service.wait();
  const failed = await service.read({ userId: '1' }, ['1']);
  assert.equal(failed.tasks[0].state, 'error'); assert(!failed.tasks[0].error.includes('private detail'));
  service.stop();
});

test('只读缓存不会调用影刀，到期只核对所选任务，强制核对跳过成功缓存并传递forceRefresh', async () => {
  let clock = Date.parse('2026-11-13T04:00:00Z');
  const calls = [], tasks = ['1', '2'].map(id => ({ id, scheduleUuid: 'plan' + id, scheduleBoundAt: from.toISOString() }));
  const client = { async getExecutionPage(params, options) { calls.push({ params, options }); return { response: { data: { dataList: [], hasData: false } }, fetched_at: new Date(clock).toISOString() }; } };
  const service = createTodayExecutions({ client, now: () => clock, tasksRepository: { listAll: async () => tasks }, pool: { query: async () => ({ rows: [] }) }, syncCoordinator: { applyRecords: async () => {} } });
  const actor = { userId: '1' };
  const initial = await service.read(actor, ['1', '2'], { refresh: 'cache' });
  assert.equal(calls.length, 0); assert.equal(initial.tasks[0].state, 'idle');
  await service.read(actor, ['1', '2'], { refresh: 'due', refreshIds: ['2'] }); await service.wait();
  assert.equal(calls.length, 1); assert.equal(calls[0].params.sourceUuid, 'plan2');
  clock += 120000; await service.read(actor, ['1', '2'], { refresh: 'cache' }); assert.equal(calls.length, 1);
  await service.read(actor, ['1', '2'], { refresh: 'force', refreshIds: ['2'] }); await service.wait();
  assert.equal(calls.length, 2); assert.equal(calls[1].options.forceRefresh, true);
  service.stop();
});
test('已有批次中新增强制请求会排队，不遗漏任务，所有账号合计最多两条采集并发', async () => {
  const tasks = ['1', '2', '3', '4'].map(id => ({ id, scheduleUuid: 'plan' + id, scheduleBoundAt: from.toISOString() }));
  const releases = [], calls = []; let active = 0, maximum = 0;
  const client = { async getExecutionPage(params) { active++; maximum = Math.max(maximum, active); calls.push(params.sourceUuid); await new Promise(resolve => releases.push(resolve)); active--; return { response: { data: { dataList: [], hasData: false } } }; } };
  const service = createTodayExecutions({ client, now: () => Date.parse('2026-11-13T04:00:00Z'), tasksRepository: { listAll: async () => tasks }, pool: { query: async () => ({ rows: [] }) }, syncCoordinator: { applyRecords: async () => {} } });
  await service.read({ userId: '1' }, ['1', '2'], { refresh: 'force' });
  const queued = await service.read({ userId: '2' }, ['3', '4'], { refresh: 'force' });
  assert.equal(calls.length, 2); assert(queued.tasks.every(task => task.state === 'loading'));
  while (releases.length) { releases.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve)); }
  await service.wait(); assert.equal(calls.length, 4); assert.equal(maximum, 2);
  service.stop();
});
