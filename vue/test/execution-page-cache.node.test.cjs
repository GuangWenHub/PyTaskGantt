const test = require('node:test');
const assert = require('node:assert/strict');
const { createYingdaoClient } = require('../server/services/yingdaoClient.cjs');
const { readToday } = require('../server/services/todayExecutions.cjs');
function fixture() {
  let clock = Date.parse('2026-11-13T04:00:00Z');
  const calls = [], client = createYingdaoClient({ accessKeyId: 'test', accessKeySecret: 'test', now: () => clock });
  client.request = async (path, params) => { calls.push({ path, params }); return { data: { dataList: [{ sourceUuid: params.sourceUuid, taskUuid: 'run', createTime: '2026-11-13 10:00:00', status: 'finish' }], hasData: false } }; };
  return { client, calls, advance: ms => { clock += ms; } };
}
test('今日完整采集与最近运行共用同一20条原始分页，复用保留真实采集时间且相互不可修改', async () => {
  const { client, calls, advance } = fixture(), times = [];
  const daily = await readToday(client, 'p', new Date('2026-11-13T00:00:00+08:00'), new Date('2026-11-14T00:00:00+08:00'), { onPage: time => times.push(time) });
  advance(1000);
  const recent = await client.listRecentTaskPage('p');
  assert.equal(calls.length, 1); assert.equal(calls[0].params.size, 20);
  assert.equal(recent.fetched_at, times[0]);
  daily[0].status = 'changed'; recent.items[0].status = 'changed';
  assert.equal((await client.listRecentTaskPage('p')).items[0].status, 'finish');
});
test('并发相同查询合并，计划、时间范围、页大小和精确游标各自隔离', async () => {
  const { client, calls } = fixture();
  await Promise.all(Array.from({ length: 6 }, () => client.getExecutionPage({ sourceUuid: 'p', size: 20 })));
  assert.equal(calls.length, 1);
  for (const scope of [{ sourceUuid: 'q' }, { sourceUuid: 'p', startTime: '2026-11-13 00:00:00' }, { sourceUuid: 'p', endTime: '2026-11-13 12:00:00' }, { sourceUuid: 'p', size: 100 }, { sourceUuid: 'p', cursorId: '2120577365733175301' }]) await client.getExecutionPage(scope);
  assert.equal(calls.length, 6);
  await assert.rejects(() => client.getExecutionPage({ sourceUuid: 'p', cursorId: 2120577365733175301 }));
});
test('15秒过期及强制刷新确实重新读取，失败不会伪造成功或返回过期结果', async () => {
  const { client, calls, advance } = fixture();
  await client.getExecutionPage({ sourceUuid: 'p' }); advance(14999);
  assert.equal((await client.getExecutionPage({ sourceUuid: 'p' })).cache_hit, true);
  await client.getExecutionPage({ sourceUuid: 'p' }, { forceRefresh: true }); assert.equal(calls.length, 2);
  advance(15000); client.request = async () => { throw new Error('upstream failure'); };
  await assert.rejects(() => client.getExecutionPage({ sourceUuid: 'p' }), /upstream failure/);
  assert.equal(client.executionPageFlights.size, 0);
  client.request = async () => ({ data: {} });
  await assert.rejects(() => client.getExecutionPage({ sourceUuid: 'p' }), /缺少列表/);
});
test('采集缓存有400页上限', async () => {
  const { client } = fixture();
  for (let index = 0; index < 405; index++) await client.getExecutionPage({ sourceUuid: String(index) });
  assert.equal(client.executionPageCache.size, 400);
});
