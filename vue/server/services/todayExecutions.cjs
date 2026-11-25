const { normalizePage, YingdaoApiError } = require('./yingdaoClient.cjs');
const { isoTimestamp } = require('./syncCoordinator.cjs');
const OFFSET = 8 * 3600_000;
function todayWindow(now) {
  const date = new Date(now + OFFSET).toISOString().slice(0, 10);
  const from = new Date(`${date}T00:00:00+08:00`);
  return { date, from, to: new Date(from.getTime() + 86400_000) };
}
async function readToday(client, uuid, from, to, { onPage = () => {}, forceRefresh = false } = {}) {
  const rows = new Map(), cursors = new Set();
  let cursorId, previousTime = Infinity;
  for (let pageIndex = 0; pageIndex < 500; pageIndex++) {
    // Share the unbounded 20-row page with recent-run lookup; filter the Shanghai day locally.
    // A first page alone never establishes complete daily coverage: continue through yesterday/end.
    const params = { sourceUuid: uuid, size: 20, cursorDirection: 'next', ...(cursorId ? { cursorId } : {}) };
    const pageResult = typeof client.getExecutionPage === 'function' ? await client.getExecutionPage(params, { forceRefresh }) : { response: await client.request('/oapi/dispatch/v2/task/list', params) };
    const raw = pageResult.response;
    onPage(pageResult.fetched_at);
    if (!Array.isArray(raw?.data) && !Array.isArray(raw?.data?.dataList) && !Array.isArray(raw?.data?.result)) throw new Error('影刀运行记录响应缺少列表');
    const { items, page } = normalizePage(raw);
    let reachedPast = false;
    for (const record of items) {
      if (String(record.sourceUuid || '') !== uuid) throw new Error('影刀记录绑定不一致');
      const timestamp = isoTimestamp(record.triggerTime || record.createTime || record.startTime);
      const time = Date.parse(timestamp || '');
      if (!Number.isFinite(time) || time > previousTime) throw new Error('影刀记录时间或分页顺序不完整');
      previousTime = time;
      if (time < from.getTime()) { reachedPast = true; continue; }
      if (time < to.getTime()) {
        if (!record.taskUuid || rows.has(record.taskUuid)) throw new Error('影刀运行记录分页重复');
        rows.set(record.taskUuid, record);
      }
    }
    const data = raw.data || {}, next = data.nextId ?? page.nextId;
    if (reachedPast || !items.length || (data.hasData ?? page.hasData) === false) return [...rows.values()];
    if (next == null || cursors.has(String(next))) throw new Error('影刀运行记录分页未完整结束');
    cursorId = String(next); cursors.add(cursorId);
  }
  throw new Error('当日运行记录超过读取上限，请缩小任务范围');
}
function clientIds(clients) {
  return [...new Set((Array.isArray(clients) ? clients : []).flatMap(client =>
    [client.robotClientUuid, client.clientUuid, client.robotClientId].filter(Boolean).map(String)))];
}
function createTodayExecutions({ pool, client, tasksRepository, syncCoordinator, now = Date.now, logger = console }) {
  const cache = new Map();
  let flight = null, stopped = false;
  const key = (task, date) => `${date}:${task.id}:${task.scheduleUuid}:${task.scheduleBoundAt}`;
  const queue = new Map(), runningKeys = new Set();
  function startWorkers() {
    if (flight || stopped || !queue.size) return;
    async function worker() {
      while (queue.size && !stopped) {
        const [id, job] = queue.entries().next().value;
        queue.delete(id); runningKeys.add(id);
        const { task, window, forceRefresh } = job;
        try {
          const times = [];
          const records = await readToday(client, task.scheduleUuid, window.from, window.to, { forceRefresh, onPage: time => { if (time) times.push(time); } });
          await syncCoordinator.applyRecords(records, { boundTasks: [task], syncedAt: new Date(now()).toISOString() });
          cache.set(id, { state: 'ready', fetched_at: times.sort()[0] || new Date(now()).toISOString(), completed_at: new Date(now()).toISOString(), attempted_at: now(), error: '' });
        } catch (error) {
          cache.set(id, { ...cache.get(id), state: 'error', attempted_at: now(), error: error instanceof YingdaoApiError ? error.message : '当日运行记录读取不完整，请稍后重试' });
          logger.warn('Today execution records could not be refreshed');
        } finally { runningKeys.delete(id); }
      }
    }
    flight = Promise.all([worker(), worker()]).finally(() => { flight = null; startWorkers(); });
  }
  function refresh(tasks, window, forceRefresh) {
    if (stopped) return;
    for (const task of tasks) {
      const id = key(task, window.date);
      if (runningKeys.has(id)) continue;
      queue.set(id, { task, window, forceRefresh: forceRefresh || Boolean(queue.get(id)?.forceRefresh) });
      cache.set(id, { ...cache.get(id), state: 'loading', attempted_at: now() });
    }
    startWorkers();
  }

  return {
    async read(actor, ids, { refresh: mode = 'due', refreshIds = ids } = {}) {
      const window = todayWindow(now());
      for (const id of cache.keys()) if (!id.startsWith(`${window.date}:`)) cache.delete(id);
      const wanted = new Set(ids);
      const tasks = (await tasksRepository.listAll(actor.userId, { currentUserIsAdmin: actor.isAdmin }))
        .filter(task => wanted.has(String(task.id)) && task.scheduleUuid && task.scheduleBoundAt);
      const selected = new Set(refreshIds);
      if (mode !== 'cache') refresh(tasks.filter(task => {
        if (!selected.has(String(task.id))) return false;
        const status = cache.get(key(task, window.date));
        return mode === 'force' || !status || (status.state !== 'loading' && now() - status.attempted_at >= 60_000);
      }), window, mode === 'force');
      const { rows } = await pool.query(`SELECT e.task_uuid, e.rpa_task_id::text AS task_id, e.schedule_uuid_at_run AS schedule_uuid,
          e.trigger_time, e.updated_time, e.end_time, e.normalized_status AS status, e.source_type, e.clients
        FROM public.rpa_task_executions e JOIN public.rpa_tasks t ON t.id=e.rpa_task_id
        WHERE t.id=ANY($1::bigint[]) AND t.deleted_at IS NULL AND e.schedule_uuid_at_run=t.schedule_uuid
          AND e.trigger_time>=t.schedule_bound_at AND e.trigger_time >= $2 AND e.trigger_time < $3
          AND e.idempotent_uuid IS NULL AND e.source_type='period'
        ORDER BY e.trigger_time, e.task_uuid LIMIT 20001`, [tasks.map(task => String(task.id)), window.from, window.to]);
      if (rows.length > 20000) throw new Error('当日状态记录过多，请缩小任务范围');
      return { date: window.date, server_time: new Date(now()).toISOString(),
        tasks: tasks.map(task => ({ id: String(task.id), schedule_uuid: task.scheduleUuid, schedule_bound_at: task.scheduleBoundAt, schedule_cron_expression: task.scheduleCronExpression || null,
          ...(cache.get(key(task, window.date)) || { state: 'idle' }) })),
        records: rows.map(({ clients, ...record }) => ({ ...record, client_ids: clientIds(clients) })) };
    },
    stop() { stopped = true; queue.clear(); },
    async wait() { while (flight) await flight; },
  };
}
module.exports = { createTodayExecutions, readToday, todayWindow, clientIds };
