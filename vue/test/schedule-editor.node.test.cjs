const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleAutofill, suggestedFinish, formatElapsedTime, elapsedBetween } = require('../shared/scheduleAutofill.mjs');
const { getEditorPlan, getRecentRuns } = require('../server/services/scheduleEditor.cjs');
const { createYingdaoClient, createScheduleDirectory } = require('../server/services/yingdaoClient.cjs');

test('计划类型与标签由规则识别，包含8点并保留复杂日历语义', () => {
  assert.deepEqual(scheduleAutofill({ type: 'day', hour: 14, minute: 5 }), { timing_mode: 'single', start: '14:05:00', expression: '', tags: ['每日'] });
  assert.deepEqual(scheduleAutofill({ type: 'week', hour: 9, minute: 30 }).tags, ['每周']);
  assert.deepEqual(scheduleAutofill({ type: 'cron', cronExpress: '0 9 2 * *' }).tags, ['每月']);
  assert.deepEqual(scheduleAutofill({ type: 'cron', cronExpress: '0 9 * * MON' }).tags, ['每周']);
  assert.equal(scheduleAutofill({ type: 'cron', cronExpress: '0 0-8/2 * * *' }).timing_mode, 'cron');
  assert.deepEqual(scheduleAutofill({ type: 'cron', cronExpress: '0 9 2 JAN *' }).tags, []);
  assert.equal(suggestedFinish('23:59:00', 120), '00:01:00');
  assert.throws(() => scheduleAutofill({ type: 'minute', minute: 7, nextTime: '2026-11-04 09:07:00' }));
  assert.throws(() => scheduleAutofill({ type: 'day', minute: 1 }));
  assert.deepEqual(scheduleAutofill({ type: 'cron', cronExpress: '0 22 L * *' }), { timing_mode: 'single', start: '22:00:00', expression: '0 22 L * *', tags: ['每月'] });
  assert.equal(scheduleAutofill({ type: 'cron', cronExpress: '0 0-8/2 L * *' }).timing_mode, 'cron');
});

test('计划元数据只返回白名单字段，不泄露应用参数；错误绑定拒绝', async () => {
  const client = { getScheduleDetail: async () => ({ schedule: { scheduleUuid: 'a', scheduleName: '计划', cronInterface: { type: 'day', hour: 0, minute: 10 }, robotList: [{ secret: 'hidden-param' }] } }) };
  const result = await getEditorPlan(client, 'a');
  assert.equal(result.defaults.start, '00:10:00');
  assert.equal(JSON.stringify(result).includes('hidden-param'), false);
  await assert.rejects(() => getEditorPlan(client, 'b'), { status: 404 });
});

test('计划等待时限和每个应用的执行时限以秒返回，关闭的时限不显示旧值', async () => {
  const client = { getScheduleDetail: async () => ({ schedule: {
    scheduleUuid: 'a',
    waitTimeoutSettings: { waitTimeoutMin: 10, waitTimeout: 600 },
    robotList: [
      { robotName: '应用甲', enableRunTimeout: true, runTimeoutSettings: { runTimeout: '23700' } },
      { robotName: '应用乙', enableRunTimeout: false, runTimeoutSettings: { runTimeout: 60 } },
    ],
  } }) };
  const result = await getEditorPlan(client, 'a');
  assert.deepEqual(result.timeout_limits, { wait_seconds: 600, execution: [
    { name: '应用甲', seconds: 23700 }, { name: '应用乙', seconds: null },
  ] });
});

test('兼容单页读取过滤其他计划，新分页入口传递服务端游标并限制页大小', async () => {
  const client = createYingdaoClient({ accessKeyId: 'test', accessKeySecret: 'test' });
  let calls = 0;
  client.request = async (path, body) => {
    calls++;
    assert.equal(path, '/oapi/dispatch/v2/task/list');
    assert.deepEqual(body, { sourceUuid: 'a', cursorDirection: 'next', size: 10 });
    return { data: { dataList: [{ taskUuid: '1', sourceUuid: 'a' }, { taskUuid: '2', sourceUuid: 'b' }], hasData: true, nextId: 'more' } };
  };
  assert.equal((await client.listRecentTasks('a')).length, 1);
  assert.equal(calls, 1);
  client.request = async (_path, body) => {
    assert.deepEqual(body, { sourceUuid: 'a', cursorDirection: 'next', size: 20, cursorId: 'older' });
    return { data: { dataList: [{ taskUuid: 'old', sourceUuid: 'a' }], hasData: true, nextId: 'next' } };
  };
  const page = await client.listRecentTaskPage('a', { cursorId: 'older', size: 999 });
  assert.equal(page.nextCursor, 'next');
  assert.equal(page.hasMore, true);
});

function detail(id, overrides = {}) {
  return { taskUuid: String(id), status: 'finish', startTime: '2026-11-04 23:59:30', endTime: '2026-11-05 00:00:31',
    jobDataList: [{ jobUuid: `job-${id}`, robotUuid: 'app', robotClientUuid: 'machine', status: 'finish', robotParams: { secret: 'never-return' } }], ...overrides };
}
function processJob(id, overrides = {}) {
  return { taskUuid: String(id), jobUuid: `job-${id}`, sourceUuid: 'a', robotUuid: 'app', robotClientUuid: 'machine', status: 'finish', dispatchCount: 1, ...overrides };
}

test('仅无重试且无异常的成功记录参与统计，失败、重试成功、未知详情和无效时间均排除', async () => {
  const client = {
    listRecentTasks: async () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(id => ({ taskUuid: String(id), status: id === 2 ? 'error' : 'finish', runTimes: 1240, sourceType: id === 9 ? 'retry' : 'schedule' })),
    queryTask: async id => {
      if (id === '4') throw new Error('unavailable');
      return { execution: detail(id, { ...(id === '3' ? { endTime: null } : {}), ...(id === '7' ? { endTime: '2026-11-05 00:01:31' } : {}), ...(id === '8' ? { retryCount: 1 } : {}), ...(id === '10' ? { errorRemark: '有异常' } : {}) }) };
    },
    getTaskProcessDetail: async id => ({ jobs: id === '6' ? [processJob(id, { status: 'error', jobUuid: 'previous-failure' }), processJob(id)] : [processJob(id, { dispatchCount: id === '5' ? 2 : 1 })] }),
  };
  const result = await getRecentRuns(client, 'a');
  assert.deepEqual(result.records.map(row => row.task_uuid), ['1', '7']);
  assert.equal(result.sample_count, 2);
  assert.equal(result.average_duration_seconds, 91);
  assert.equal(result.max_duration_seconds, 121);
  assert.equal(result.min_duration_seconds, 61);
  assert.equal(result.rounded_duration_seconds, null);
  assert.equal(result.verification_failed_count, 1);
  assert.equal(result.incomplete, true);
  assert.equal(result.records[1].duration_seconds, 121);
  assert.equal(result.skipped_count, 7);
  assert.equal(JSON.stringify(result).includes('never-return'), false);
});

test('首次候选即使已停止，也独立显示为最近一次，不纳入成功样本', async () => {
  const result = await getRecentRuns({
    listRecentTaskPage: async () => ({
      items: [{ taskUuid: 'stopped-run', status: 'stop', createTime: '2026-11-04 23:59:00' }],
      hasMore: false,
    }),
    queryTask: async id => ({ execution: detail(id, { status: 'stop' }) }),
  }, 'a');
  assert.equal(result.latest_run.task_uuid, 'stopped-run');
  assert.equal(result.latest_run.normalized_status, '已停止');
  assert.equal(result.latest_run.duration_seconds, 61);
  assert.deepEqual(result.records, []);
});

test('最近一次成功运行与成功统计复用同一条详情请求', async () => {
  const calls = [];
  const result = await getRecentRuns({
    listRecentTasks: async () => [{ taskUuid: '1', status: 'finish' }],
    queryTask: async id => { calls.push(id); return { execution: detail(id) }; },
    getTaskProcessDetail: async id => ({ jobs: [processJob(id)] }),
  }, 'a');
  assert.deepEqual(calls, ['1']);
  assert.equal(result.latest_run.duration_seconds, 61);
  assert.equal(result.records[0].duration_seconds, 61);
});

test('向前分页补足十次，最后一个样本之前遇到失败仍不能漏过紧接着的合格记录', async () => {
  const pages = [], queried = [];
  const client = {
    async listRecentTaskPage(_uuid, options) {
      pages.push(options.cursorId);
      const first = !options.cursorId;
      return { items: Array.from({ length: 20 }, (_, i) => ({ taskUuid: String(i + (first ? 1 : 21)), status: first && i < 12 ? 'error' : 'finish' })), hasMore: true, nextCursor: first ? 'page-2' : 'page-3' };
    },
    async queryTask(id) { queried.push(id); return { execution: detail(id, { status: ['21', '23'].includes(id) ? 'error' : 'finish' }) }; },
    async getTaskProcessDetail(id) { return { jobs: [processJob(id)] }; },
  };
  const result = await getRecentRuns(client, 'a');
  assert.deepEqual(pages, [undefined, 'page-2']);
  assert.deepEqual(result.records.map(row => row.task_uuid), ['13','14','15','16','17','18','19','20','22','24']);
  assert.equal(queried.includes('25'), false);
  assert.equal(result.sample_count, 10);
});

test('重试复用Job、同应用同机器再次运行、未知派发次数及其他任务的过程均不视为纯成功', async () => {
  const client = {
    async listRecentTasks() { return ['1','2','3','4'].map(taskUuid => ({ taskUuid, status: 'finish' })); },
    async queryTask(id) { return { execution: detail(id) }; },
    async getTaskProcessDetail(id) {
      return { jobs: id === '1' ? [processJob(id, { dispatchCount: 2 })]
        : id === '2' ? [processJob(id), processJob(id, { jobUuid: 'second-success-attempt' })]
        : id === '3' ? [processJob(id, { dispatchCount: undefined })] : [processJob(id, { taskUuid: 'someone-else' })] };
    },
  };
  const result = await getRecentRuns(client, 'a');
  assert.equal(result.sample_count, 0);
  assert.equal(result.rounded_duration_seconds, null);
});

test('只查最近200条候选，不把失败凑成十次；重复游标和Task不能形成无限循环', async () => {
  let pages = 0;
  const client = {
    async listRecentTaskPage() { pages++; return { items: Array.from({ length: 20 }, (_, i) => ({ taskUuid: `${pages}-${i}`, status: 'error' })), hasMore: true, nextCursor: String(pages) }; },
    async queryTask() { throw new Error('must not query failed task'); },
  };
  const result = await getRecentRuns(client, 'a');
  assert.equal(pages, 10);
  assert.equal(result.inspected_count, 200);
  assert.equal(result.sample_count, 0);
  assert.equal(result.search_limit_reached, true);
  client.listRecentTaskPage = async () => ({ items: [{ taskUuid: 'duplicate', status: 'error' }], hasMore: true, nextCursor: 'same' });
  const repeated = await getRecentRuns(client, 'a');
  assert.equal(repeated.inspected_count, 1);
});

test('多台机器各自一次成功不是重试，允许合法并行执行和成功状态别名', async () => {
  const client = {
    async listRecentTasks() { return [{ taskUuid: 'parallel', sourceUuid: 'a', status: 'success', runTimes: 999 }]; },
    async queryTask() { return { execution: detail('parallel', { status: 'success', statusName: '完成，无异常', jobDataList: ['A','B'].map(robotClientUuid => ({ jobUuid: `job-${robotClientUuid}`, robotClientUuid, robotUuid: 'app', status: 'finish' })) }) }; },
    async getTaskProcessDetail(id, clientUuid) { return { jobs: [processJob(id, { jobUuid: `job-${clientUuid}`, robotClientUuid: clientUuid })] }; },
  };
  const result = await getRecentRuns(client, 'a');
  assert.equal(result.sample_count, 1);
  assert.equal(result.max_duration_seconds, 61);
});

test('空历史不产生虚构平均值，相同计划并发查询复用短期缓存', async () => {
  let calls = 0;
  const directory = createScheduleDirectory({ client: {
    getScheduleDetail: async () => ({ schedule: { scheduleUuid: 'a' } }),
    listRecentTasks: async () => { calls++; return []; },
  } });
  const values = await Promise.all([directory.getRecentRuns('a'), directory.getRecentRuns('a')]);
  assert.equal(values[0].average_duration_seconds, null);
  assert.equal(values[0].rounded_duration_seconds, null);
  assert.equal(values[0].max_duration_seconds, null);
  assert.equal(values[0].min_duration_seconds, null);
  await directory.getRecentRuns('a');
  assert.equal(calls, 1);
});

test('耗时统一显示时分秒，支持跨天、超过24小时、零值和未知值', () => {
  assert.equal(formatElapsedTime(0), '00:00:00');
  assert.equal(formatElapsedTime(3661), '01:01:01');
  assert.equal(formatElapsedTime(90061), '25:01:01');
  assert.equal(formatElapsedTime(null), '耗时未知');
  assert.equal(formatElapsedTime(elapsedBetween('23:59:00', '00:02:00')), '00:03:00');
  assert.equal(elapsedBetween(null, '00:02:00'), null);
});

test('核验失败的统计不进入短期缓存，下一次打开可重新核验恢复正常', async () => {
  let fail = true, queried = 0;
  const directory = createScheduleDirectory({ client: {
    getScheduleDetail: async () => ({ schedule: { scheduleUuid: 'a' } }),
    listRecentTasks: async () => [{ taskUuid: '1', status: 'finish' }],
    queryTask: async () => { queried++; if (fail) throw new Error('upstream unavailable'); return { execution: detail('1') }; },
    getTaskProcessDetail: async () => ({ jobs: [processJob('1')] }),
  } });
  assert.equal((await directory.getRecentRuns('a')).incomplete, true);
  fail = false;
  const healthy = await directory.getRecentRuns('a');
  assert.equal(healthy.incomplete, false);
  assert.equal(healthy.rounded_duration_seconds, 120);
  assert.equal(queried, 2);
  await directory.getRecentRuns('a');
  assert.equal(queried, 2);
});
