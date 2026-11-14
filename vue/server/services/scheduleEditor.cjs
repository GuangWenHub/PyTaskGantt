const { scheduleAutofill } = require('../../shared/scheduleAutofill.mjs');
const { normalizeScheduleDispatch } = require('../../shared/scheduleDispatch.mjs');
const { NotFoundError } = require('../errors.cjs');

async function getEditorPlan(client, uuid) {
  const result = await client.getScheduleDetail(uuid);
  const plan = result.schedule;
  if (!plan || String(plan.scheduleUuid) !== uuid) {
    throw new NotFoundError('未找到对应影刀计划');
  }
  let defaults = null, ruleError = '';
  try { defaults = scheduleAutofill(plan.cronInterface || {}); }
  catch (error) { ruleError = error.message; }
  return {
    schedule_uuid: uuid, schedule_name: String(plan.scheduleName || ''),
    dispatch: normalizeScheduleDispatch(plan), defaults, rule_error: ruleError,
    stale: Boolean(result.cache?.stale), fetched_at: result.cache?.fetchedAt || null,
  };
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const text = value.trim();
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text) ? `${text.replace(' ', 'T')}+08:00` : text);
}

const SUCCESS = new Set(['finish', 'finished', 'success', 'succeeded']);
function successful(record) {
  if (!record || !SUCCESS.has(String(record.status || '').toLowerCase())) return false;
  if (['error', 'errorRemark', 'errorMessage', 'exception', 'exceptionMessage'].some(key => Boolean(record[key]))) return false;
  const text = [record.statusName, record.remark].filter(Boolean).join(' ')
    .replace(/无异常|无错误|无重试|未重试|没有异常|未发生异常/g, '');
  return !/失败|异常|错误|重试|retry|exception|timeout/i.test(text);
}
function retryMarked(record) {
  // runTimes is the plan's lifetime execution number, NOT a retry count.
  return /retry|重试/i.test(String(record?.sourceType || ''))
    || ['retryCount', 'retryTimes'].some(key => Number(record?.[key]) > 0)
    || record?.isRetry === true || record?.retried === true;
}
async function eligibleRun(client, uuid, row, onFailure) {
  if (!successful(row) || retryMarked(row)) return null;
  try {
    const detail = (await client.queryTask(row.taskUuid)).execution;
    if (!successful(detail) || retryMarked(detail) || (detail.taskUuid && String(detail.taskUuid) !== String(row.taskUuid))) return null;
    const detailJobs = detail.jobDataList;
    if (!Array.isArray(detailJobs) || !detailJobs.length || detailJobs.some(job => !successful(job) || retryMarked(job))) return null;
    const clients = [...new Set(detailJobs.map(job => job.robotClientUuid).filter(Boolean).map(String))];
    if (!clients.length || clients.length > 20 || detailJobs.some(job => !job.robotClientUuid || !job.jobUuid)) return null;
    const jobs = new Map();
    for (const clientUuid of clients) {
      const result = await client.getTaskProcessDetail(row.taskUuid, clientUuid);
      if (!Array.isArray(result.jobs) || !result.jobs.length) return null;
      for (const job of result.jobs) {
        if (!job.jobUuid || (job.taskUuid && String(job.taskUuid) !== String(row.taskUuid))
          || (job.sourceUuid && String(job.sourceUuid) !== String(uuid))
          || (job.robotClientUuid && String(job.robotClientUuid) !== clientUuid)
          || !successful(job) || retryMarked(job) || Number(job.dispatchCount) !== 1) return null;
        jobs.set(String(job.jobUuid), job);
      }
    }
    if (detailJobs.some(job => !jobs.has(String(job.jobUuid)))) return null;
    const attempts = new Set();
    for (const job of jobs.values()) {
      if (!job.robotUuid || !job.robotClientUuid) return null;
      const group = JSON.stringify([job.robotUuid, job.robotClientUuid]);
      if (attempts.has(group)) return null; // Repeated attempts of the same app on the same client.
      attempts.add(group);
    }
    const start = detail.startTime || null, end = detail.endTime || null;
    const delta = (timestamp(end) - timestamp(start)) / 1000;
    if (!Number.isFinite(delta) || delta < 0) return null;
    return { task_uuid: String(row.taskUuid), status: String(detail.status), status_name: String(detail.statusName || '运行成功'),
      start_time: start, end_time: end, duration_seconds: delta, detail_unavailable: false };
  } catch { onFailure(); return null; } // Transport failures are distinct from ineligible executions.
}

async function getRecentRuns(client, uuid) {
  const records = [], seen = new Set(), cursors = new Set(), collectedTimes = [];
  let cursorId, inspected = 0, more = false, verificationFailed = 0;
  // Bounded search, independent of the unbounded execution-history synchronizer.
  for (let page = 0; page < 10 && records.length < 10 && inspected < 200; page++) {
    const result = typeof client.listRecentTaskPage === 'function'
      ? await client.listRecentTaskPage(uuid, { cursorId, size: 20 })
      : { items: await client.listRecentTasks(uuid), hasMore: false };
    if (result.fetched_at) collectedTimes.push(result.fetched_at);
    const candidates = result.items.filter(row => row.taskUuid && !seen.has(String(row.taskUuid))
      && (!row.sourceUuid || String(row.sourceUuid) === String(uuid))).filter(row => { seen.add(String(row.taskUuid)); return true; });
    for (let i = 0; i < candidates.length && records.length < 10 && inspected < 200;) {
      const batch = candidates.slice(i, i + Math.min(2, 10 - records.length, 200 - inspected));
      i += batch.length;
      inspected += batch.length;
      records.push(...(await Promise.all(batch.map(row => eligibleRun(client, uuid, row, () => { verificationFailed++; })))).filter(Boolean));
    }
    more = Boolean(result.hasMore);
    if (!more || !result.nextCursor || cursors.has(String(result.nextCursor))) break;
    cursorId = String(result.nextCursor); cursors.add(cursorId);
  }
  const samples = records;
  const average = samples.length ? samples.reduce((sum, row) => sum + row.duration_seconds, 0) / samples.length : null;
  const maximum = samples.length ? Math.max(...samples.map(row => row.duration_seconds)) : null;
  const minimum = samples.length ? Math.min(...samples.map(row => row.duration_seconds)) : null;
  return { records, fetched_at: collectedTimes.sort()[0] || new Date().toISOString(), completed_at: new Date().toISOString(), sample_count: samples.length, inspected_count: inspected, skipped_count: inspected - records.length - verificationFailed,
    verification_failed_count: verificationFailed, incomplete: verificationFailed > 0,
    search_limit_reached: records.length < 10 && more, average_duration_seconds: average,
    max_duration_seconds: maximum, min_duration_seconds: minimum,
    rounded_duration_seconds: maximum === null || verificationFailed > 0 ? null : Math.max(60, Math.ceil(maximum / 60) * 60) };
}

module.exports = { getEditorPlan, getRecentRuns };
