const { randomUUID } = require('node:crypto');
const { ConflictError, ValidationError, NotFoundError, AuthorizationError, AppError } = require('../errors.cjs');
const { presentTask } = require('../presenters.cjs');
const { normalizeActor } = require('./taskMutationService.cjs');
const { normalizeScheduleDispatch } = require('../../shared/scheduleDispatch.mjs');
const { scheduleAutofill, elapsedBetween, suggestedFinish } = require('../../shared/scheduleAutofill.mjs');
const { reconciliationFields, ignoredFields } = require('../../shared/reconciliationPolicy.mjs');
const { parseYingdaoCron } = require('../../shared/yingdaoCron.mjs');
const { getRecentRuns } = require('./scheduleEditor.cjs');

function canonicalDispatch(dispatch = {}) {
  return { execute_scope: dispatch.execute_scope || '', client_scope: dispatch.client_scope || '',
    clients: [...new Set((dispatch.clients || []).map(client => String(client.id)))].sort() };
}
function sourceFingerprint(plan) {
  return JSON.stringify([plan.schedule_uuid, plan.schedule_name, plan.defaults, canonicalDispatch(plan.dispatch)]);
}
function localFingerprint(task) {
  return JSON.stringify([task.version, task.schedule_uuid, task.owner?.id, task.task, task.start, task.finish, task.bot,
    task.timing_mode, task.expected_duration_seconds, task.schedule_cron_expression || '', canonicalDispatch(task.schedule_dispatch)]);
}
function missing(error) { return Number(error?.status) === 404 || Number(error?.code) === 404; }
function safeError(error) { return error instanceof AppError || error?.name === 'YingdaoApiError' ? error.message : '读取失败，请重试或检查服务日志'; }

function differences(task, plan) {
  const defaults = plan.defaults;
  const names = plan.dispatch.clients.map(client => client.name.split('@')[0]);
  const bot = names.includes(task.bot) ? task.bot : names[0];
  const duration = task.timing_mode === 'cron' ? task.expected_duration_seconds : elapsedBetween(task.start, task.finish);
  const changes = { task: plan.schedule_name, bot, timing_mode: defaults.timing_mode, start: defaults.start };
  if (defaults.timing_mode === 'single') {
    if (!Number.isFinite(duration) || duration < 0 || duration >= 86400) throw new ValidationError('本地时长无法转换为单次任务，请先确认时长');
    changes.finish = suggestedFinish(defaults.start, duration);
  }
  const labels = { task: '任务名称', bot: '机器人', timing_mode: '任务类型', start: '开始时间', finish: '结束时间' };
  const fields = [];
  for (const [key, value] of Object.entries(changes)) {
    if (task[key] === value) delete changes[key];
    else fields.push({ field: key, label: labels[key], local: task[key], remote: value });
  }
  if (JSON.stringify(canonicalDispatch(task.schedule_dispatch)) !== JSON.stringify(canonicalDispatch(plan.dispatch))) {
    fields.push({ field: 'schedule_dispatch', label: '机器与执行策略', local: task.schedule_dispatch, remote: plan.dispatch });
  }
  if ((task.schedule_cron_expression || '') !== (defaults.expression || '')) {
    fields.push({ field: 'schedule_cron_expression', label: '循环规则', local: task.schedule_cron_expression || '', remote: defaults.expression || '' });
  }
  // Cache-only changes still pass the strict mutation schema; no-op rows never reach this path.
  if (fields.length && !Object.keys(changes).length) changes.timing_mode = defaults.timing_mode;
  return { fields, changes };
}

function createScheduleReconciliation({ client, tasksRepository, taskMutationService, stateRepository, now = Date.now, logger = console }) {
  if (!stateRepository) throw new TypeError('stateRepository is required');
  const jobs = new Map();
  const ttl = 60 * 60 * 1000;
  async function jobFor(id, actorInput, writing = false) {
    normalizeActor(actorInput);
    const active = jobs.get(id);
    const job = active?.state === 'scanning' ? active : await stateRepository.get(id);
    if (!job) throw new ConflictError('SCAN_EXPIRED', '扫描结果不存在，请重新扫描');
    if (writing && now() > job.expires) throw new ConflictError('SCAN_EXPIRED', '扫描结果已过期，请重新扫描');
    if (job.state === 'scanning' && !jobs.has(id)) {
      const release = await stateRepository.acquireScanLock();
      if (release) {
        try { job.state = 'failed'; job.error = '上次扫描被服务重启中断，可查看已有结果或重新扫描'; await stateRepository.save(job); }
        finally { await release(); }
      }
    }
    return job;
  }
  function view(job, actorInput) {
    if (!job) return null;
    const actor = normalizeActor(actorInput);
    return { id: job.id, state: job.state, progress: job.progress, scanned_at: job.scannedAt,
      started_at: job.startedAt, error: job.error || '', unchanged: job.unchanged, total: job.total, ignored: job.ignored || 0,
      entries: job.entries.map(({ sourceSignature, localSignature, plan, changes, ...entry }) => ({ ...entry,
        can_apply: entry.kind !== 'error' && (!entry.task_id || Boolean(entry.owner && (actor.isAdmin || String(entry.owner.id) === actor.userId))) })) };
  }
  async function readPlan(uuid) {
    const result = await client.getScheduleDetail(uuid, { forceRefresh: true });
    if (result.cache?.stale) throw new ConflictError('UPSTREAM_STALE', '影刀详情读取失败，本次不使用旧缓存执行同步');
    const source = result.schedule;
    if (!source) throw new NotFoundError('影刀未找到该计划');
    if (String(source.scheduleUuid) !== uuid) throw new ConflictError('UPSTREAM_MISMATCH', '影刀返回的计划UUID不匹配');
    if (source.cronInterface?.type === 'manual') throw new ConflictError('PLAN_UNSCHEDULED', '手动触发计划没有固定排班时刻，请人工安排，不自动覆盖');
    let defaults;
    try { defaults = scheduleAutofill(source.cronInterface || {}); }
    catch (error) { throw new ValidationError(error.message); }
    if (!source.scheduleName) throw new ValidationError('影刀计划名称为空，不能同步');
    const dispatch = normalizeScheduleDispatch(source);
    dispatch.clients.sort((a, b) => a.id.localeCompare(b.id));
    if (!dispatch.clients.length) throw new ValidationError('计划未列出具体候选机器，无法自动同步');
    return { schedule_uuid: uuid, schedule_name: String(source.scheduleName || ''), defaults, dispatch,
      fetched_at: result.cache?.fetchedAt || new Date(now()).toISOString() };
  }
  async function assertMissing(uuid) {
    try {
      const result = await client.getScheduleDetail(uuid, { forceRefresh: true });
      if (result.cache?.stale) throw new ConflictError('UPSTREAM_STALE', '影刀详情不可用，不能确认移除');
      if (result.schedule) throw new ConflictError('PLAN_STILL_EXISTS', '影刀计划仍然存在，请重新扫描');
    } catch (error) { if (!missing(error)) throw error; }
  }
  async function localTasks(actor) {
    return (await tasksRepository.listAll(actor.userId, { currentUserIsAdmin: actor.isAdmin })).map(presentTask);
  }
  async function scan(job, actor) {
    const inventory = await client.getScheduleInventory(info => { job.progress = { stage: info.enabled ? '读取启用计划' : '读取停用计划', done: info.count, total: info.total }; });
    const tasks = await localTasks(actor);
    const bound = new Map(tasks.filter(task => task.schedule_uuid).map(task => [task.schedule_uuid, task]));
    const sources = new Map(inventory.map(plan => [plan.schedule_uuid, plan]));
    const work = [...inventory, ...tasks.filter(task => task.schedule_uuid && task.owner && !sources.has(task.schedule_uuid)).map(task => ({ schedule_uuid: task.schedule_uuid, absent: true }))];
    job.total = work.length;
    job.progress = { stage: '核对计划详情', done: 0, total: work.length };
    // Two workers, all requests still pass the existing endpoint rate limiter.
    let index = 0;
    async function worker() {
      while (index < work.length) {
        const item = work[index++], uuid = item.schedule_uuid, task = bound.get(uuid);
        const base = { id: randomUUID(), schedule_uuid: uuid, name: task?.task || item.schedule_name || uuid,
          task_id: task?.id || null, version: task?.version || null, owner: task?.owner || null,
          enabled: item.enabled, can_apply: !task || task.can_edit, applied: false };
        try {
          if (item.enabled === false) {
            if (task) job.entries.push({ ...base, kind: 'delete', delete_reason: 'disabled', warning: '影刀计划已停用，确认后仅移除本地任务，不修改影刀计划。', fields: [], localSignature: localFingerprint(task) });
            else job.ignored++;
          } else if (item.absent) {
            await assertMissing(uuid);
            job.entries.push({ ...base, kind: 'delete', warning: '影刀未找到，可能已移除或当前凭证不可见；请人工核对后确认，仅软删除本地任务。', fields: [], localSignature: localFingerprint(task) });
          } else {
            const plan = await readPlan(uuid);
            if (task && (!task.owner || task.is_legacy_unbound)) throw new ValidationError('历史未归属任务不能自动修改，请先分配并绑定');
            const diff = task ? differences(task, plan) : { fields: [], changes: {} };
            if (task && !diff.fields.length) job.unchanged++;
            else job.entries.push({ ...base, kind: task ? 'update' : 'create', fields: diff.fields, changes: diff.changes,
              plan, sourceSignature: sourceFingerprint(plan), localSignature: task ? localFingerprint(task) : null,
              defaults: !task ? { task: plan.schedule_name, schedule_uuid: uuid, schedule_name: plan.schedule_name,
                bot: plan.dispatch.clients[0].name.split('@')[0], start: plan.defaults.start, finish: plan.defaults.start,
                tags: plan.defaults.tags, timing_mode: plan.defaults.timing_mode, expected_duration_seconds: 60,
                schedule_dispatch: plan.dispatch, schedule_cron_expression: plan.defaults.expression } : undefined });
          }
        } catch (error) {
          if (error.code === 'PLAN_UNSCHEDULED') job.ignored++;
          else job.entries.push({ ...base, kind: 'error', can_apply: false, fields: [], error: safeError(error), error_code: error.code });
        }
        job.progress.done++;
      }
    }
    await Promise.all([worker(), worker()]);
    job.state = 'ready';
    job.scannedAt = new Date(now()).toISOString();
    job.expires = now() + ttl;
  }
  const service = {
    async start(actorInput) {
      const actor = normalizeActor(actorInput);
      for (const [id, job] of jobs) if (job.state !== 'scanning' && now() > job.expires && !job.applying) jobs.delete(id);
      for (const job of jobs.values()) if (job.state === 'scanning') return view(job, actor);
      const release = await stateRepository.acquireScanLock();
      if (!release) {
        const active = await stateRepository.latest();
        if (active) return view(active, actor);
        throw new ConflictError('SCAN_BUSY', '正在启动后台扫描，请稍后查看');
      }
      const job = { id: randomUUID(), userId: actor.userId, state: 'scanning', entries: [], progress: { stage: '准备扫描', done: 0, total: 0 }, unchanged: 0, total: 0, ignored: 0, startedAt: new Date(now()).toISOString(), scannedAt: null, expires: now() + ttl, applying: false };
      try { await stateRepository.save(job); } catch (error) { await release(); throw error; }
      jobs.set(job.id, job);
      void Promise.resolve().then(async () => { await scan(job, actor); release.assertHeld?.(); }).catch(error => { job.state = 'failed'; job.entries = []; job.error = safeError(error); job.expires = now() + ttl; })
        .then(() => stateRepository.save(job)).catch(() => { job.state = 'failed'; job.error = '扫描结果保存失败，请重试'; logger.error('Failed to persist plan comparison'); })
        .finally(async () => { try { await release(); } catch { logger.error('Failed to release plan comparison lock'); } });
      return view(job, actor);
    },
    async get(id, actor) {
      const result = view(await jobFor(id, actor), actor);
      const current = new Map((await localTasks(normalizeActor(actor))).map(task => [task.id, task]));
      result.entries = result.entries.map(entry => ({ ...entry, can_apply: entry.kind !== 'error' && (!entry.task_id || Boolean(current.get(entry.task_id)?.can_edit)) }));
      return result;
    },
    async sharedState(actorInput) {
      const actor = normalizeActor(actorInput);
      const [latest, ready, whitelist] = await Promise.all([stateRepository.latest(), stateRepository.latest(true), stateRepository.listWhitelist()]);
      const job = latest ? await service.get(latest.id, actor) : null;
      return { job, result: ready ? (ready.id === job?.id ? job : await service.get(ready.id, actor)) : null,
        whitelist: whitelist.map(rule => ({ ...rule, can_edit: actor.isAdmin || rule.owner_user_id === actor.userId })) };
    },
    async changeRule(actorInput, { task_id, schedule_uuid, field }, remove = false) {
      const actor = normalizeActor(actorInput);
      if (field === 'plan') {
        if (task_id !== null || !schedule_uuid) throw new ValidationError('待新增白名单需要计划UUID，不接受本地任务ID');
        let name;
        if (!remove) {
          const result = await client.getScheduleDetail(schedule_uuid, { forceRefresh: true });
          if (result.cache?.stale) throw new ConflictError('UPSTREAM_STALE', '无法核验影刀计划，请稍后重试');
          if (!result.schedule || String(result.schedule.scheduleUuid) !== schedule_uuid) throw new NotFoundError('未找到对应影刀计划');
          name = String(result.schedule.scheduleName || schedule_uuid);
        }
        return stateRepository.withPolicyLock(async assertHeld => {
          if (!remove && (await localTasks(actor)).some(task => task.schedule_uuid === schedule_uuid)) throw new ConflictError('SCHEDULE_ALREADY_BOUND', '该计划已绑定本地任务，请刷新后按具体属性设置白名单');
          assertHeld?.();
          if (remove) await stateRepository.removePlanRule(schedule_uuid, actor);
          else await stateRepository.addPlanRule(schedule_uuid, name, actor);
          return service.sharedState(actor);
        });
      }
      if (!reconciliationFields.includes(field)) throw new ValidationError('不支持忽略此属性');
      return stateRepository.withPolicyLock(async assertHeld => {
        const task = (await localTasks(actor)).find(task => task.id === String(task_id));
        if (!task || !task.can_edit) throw new AuthorizationError('只有任务所有者或管理员可以修改白名单');
        if (!remove && task.schedule_uuid !== schedule_uuid) throw new ConflictError('BINDING_CHANGED', '绑定已变化，请重新扫描');
        assertHeld?.();
        if (remove) await stateRepository.removeRule(task_id, schedule_uuid, field, actor);
        else await stateRepository.addRule(task_id, schedule_uuid, field, actor);
        return service.sharedState(actor);
      });
    },
    async restoreRules(actorInput, rules) {
      const actor = normalizeActor(actorInput);
      if (!Array.isArray(rules) || !rules.length || rules.length > 500 || rules.some(rule => !rule.schedule_uuid || (rule.field === 'plan' ? rule.task_id !== null : !rule.task_id || !reconciliationFields.includes(rule.field)))
        || new Set(rules.map(rule => JSON.stringify([rule.task_id, rule.schedule_uuid, rule.field]))).size !== rules.length) throw new ValidationError('请选择1至500条不重复的白名单属性');
      return stateRepository.withPolicyLock(async assertHeld => {
        assertHeld?.();
        await stateRepository.removeRules(rules, actor);
        return service.sharedState(actor);
      });
    },
    async recheck(id, actorInput, entryIds) {
      const actor = normalizeActor(actorInput);
      await jobFor(id, actor, true);
      if (!Array.isArray(entryIds) || !entryIds.length || entryIds.length > 500 || new Set(entryIds).size !== entryIds.length) throw new ValidationError('请选择1至500条不重复的异常记录');
      return stateRepository.withPolicyLock(async assertHeld => {
        const job = await stateRepository.get(id);
        if (!job || job.state !== 'ready' || now() > job.expires) throw new ConflictError('SCAN_EXPIRED', '扫描结果已过期或未完成，请重新扫描');
        const selected = entryIds.map(entryId => job.entries.find(entry => entry.id === entryId));
        if (selected.some(entry => !entry || entry.kind !== 'error' || entry.applied)) throw new ValidationError('只能重新核验需人工处理的记录');
        const tasks = await localTasks(actor), current = new Map(tasks.filter(task => task.schedule_uuid).map(task => [task.schedule_uuid, task]));
        const inventory = new Map((await client.getScheduleInventory()).map(plan => [plan.schedule_uuid, plan]));
        const replacements = new Map();
        let next = 0;
        async function worker() {
          while (next < selected.length) {
            const entry = selected[next++], uuid = entry.schedule_uuid, task = current.get(uuid);
            const base = { id: entry.id, schedule_uuid: uuid, name: task?.task || entry.name, task_id: task?.id || null,
              version: task?.version || null, owner: task?.owner || null, enabled: entry.enabled, can_apply: !task || task.can_edit, applied: false };
            try {
              const status = inventory.get(uuid);
              if (status?.enabled === false) {
                if (task) replacements.set(entry.id, { ...base, enabled: false, kind: 'delete', delete_reason: 'disabled', fields: [], localSignature: localFingerprint(task), warning: '影刀计划已停用，确认后仅移除本地任务，不修改影刀计划。' });
                else { job.ignored++; replacements.set(entry.id, null); }
                continue;
              }
              if (status?.enabled !== true) throw new ConflictError('UPSTREAM_CHANGED', '影刀计划当前不在启用列表，请重新扫描');
              base.enabled = true;
              const plan = await readPlan(uuid);
              if (task && (!task.owner || task.is_legacy_unbound)) throw new ValidationError('历史未归属任务不能自动修改，请先分配并绑定');
              const diff = task ? differences(task, plan) : { fields: [], changes: {} };
              if (task && !diff.fields.length) { job.unchanged++; replacements.set(entry.id, null); }
              else replacements.set(entry.id, { ...base, kind: task ? 'update' : 'create', fields: diff.fields, changes: diff.changes,
                plan, sourceSignature: sourceFingerprint(plan), localSignature: task ? localFingerprint(task) : null,
                defaults: !task ? { task: plan.schedule_name, schedule_uuid: uuid, schedule_name: plan.schedule_name,
                  bot: plan.dispatch.clients[0].name.split('@')[0], start: plan.defaults.start, finish: plan.defaults.start,
                  tags: plan.defaults.tags, timing_mode: plan.defaults.timing_mode, expected_duration_seconds: 60,
                  schedule_dispatch: plan.dispatch, schedule_cron_expression: plan.defaults.expression } : undefined });
            } catch (error) {
              if (error.code === 'PLAN_UNSCHEDULED') { job.ignored++; replacements.set(entry.id, null); }
              else replacements.set(entry.id, { ...base, kind: 'error', can_apply: false, fields: [], error: safeError(error), error_code: error.code });
            }
          }
        }
        await Promise.all([worker(), worker()]);
        job.entries = job.entries.flatMap(entry => replacements.has(entry.id) ? (replacements.get(entry.id) ? [replacements.get(entry.id)] : []) : [entry]);
        if (now() > job.expires) throw new ConflictError('SCAN_EXPIRED', '扫描结果已过期，请重新扫描');
        assertHeld?.();
        await stateRepository.save(job);
        return service.sharedState(actor);
      });
    },
    async apply(id, actorInput, { entry_ids, form, bulk_create = false } = {}) {
      const actor = normalizeActor(actorInput), job = await jobFor(id, actor, true);
      if (job.state !== 'ready' || job.applying) throw new ConflictError('SCAN_BUSY', '扫描未完成或正在应用，请稍后再试');
      if (!Array.isArray(entry_ids) || !entry_ids.length || entry_ids.length > 500 || new Set(entry_ids).size !== entry_ids.length) throw new ValidationError('请选择1至500条不重复的差异');
      const selected = entry_ids.map(entryId => job.entries.find(entry => entry.id === entryId));
      if (selected.some(entry => !entry || entry.applied || entry.kind === 'error')) throw new ConflictError('SCAN_CHANGED', '所选差异不可执行，请重新扫描');
      if (typeof bulk_create !== 'boolean') throw new ValidationError('批量新增标记不正确');
      if (bulk_create && (form !== undefined || selected.some(entry => entry.kind !== 'create'))) throw new ValidationError('一键新增只能包含待新增计划，不能夹带表单或其他操作');
      if (!bulk_create && selected.some(entry => entry.kind === 'create') && selected.length !== 1) throw new ValidationError('新增任务请逐条进入卡片确认');
      job.applying = true;
      try { return await stateRepository.withPolicyLock(async assertHeld => {
        const tasks = await localTasks(actor), current = new Map(tasks.map(task => [task.id, task]));
        const rules = await stateRepository.listWhitelist();
        if (selected.some(entry => entry.kind === 'create' && rules.some(rule => rule.field === 'plan' && rule.schedule_uuid === entry.schedule_uuid))) throw new ConflictError('PLAN_IGNORED', '所选计划已加入新增白名单，请先恢复新增提醒');
        const mutations = [], syncPlans = new Map();
        for (const entry of selected) if (entry.kind !== 'create' && !current.get(entry.task_id)?.can_edit) throw new AuthorizationError('当前无权修改所选任务');
        // Detail API does not expose enabled. Re-read both complete lists before
        // applying a cached result, so a re-enabled plan cannot be deleted.
        const inventory = new Map((await client.getScheduleInventory()).map(plan => [plan.schedule_uuid, plan]));
        for (const entry of selected) {
          const enabled = inventory.get(entry.schedule_uuid)?.enabled;
          if (entry.kind === 'delete' && entry.delete_reason === 'disabled') {
            if (enabled !== false) throw new ConflictError('UPSTREAM_CHANGED', '计划已重新启用或状态变化，请重新扫描后确认移除');
          } else if (entry.kind !== 'delete' && enabled !== true) {
            throw new ConflictError('UPSTREAM_CHANGED', '计划已停用或状态变化，请重新扫描');
          }
        }
        const durations = new Map();
        let durationFallbackCount = 0;
        if (bulk_create) {
          if (selected.some(entry => tasks.some(task => task.schedule_uuid === entry.schedule_uuid))) throw new ConflictError('SCHEDULE_ALREADY_BOUND', '有计划已被本地任务绑定，请重新扫描');
          let next = 0, historyFailed = false;
          async function readDurations() {
            while (next < selected.length && !historyFailed) {
              const entry = selected[next++];
              let recent;
              try { recent = await getRecentRuns(client, entry.schedule_uuid); }
              catch (error) { historyFailed = true; throw error; }
              if (recent.verification_failed_count) {
                historyFailed = true;
                throw new AppError(502, 'RUN_HISTORY_UNAVAILABLE', '部分运行记录核验失败，请稍后重试；本次未新增任务，不使用1分钟代替未知耗时');
              }
              if (recent.rounded_duration_seconds === null) durationFallbackCount++;
              durations.set(entry.id, recent.rounded_duration_seconds ?? 60);
            }
          }
          const histories = await Promise.allSettled([readDurations(), readDurations()]);
          const failed = histories.find(result => result.status === 'rejected');
          if (failed) throw failed.reason;
        }
        for (const entry of selected) {
          if (entry.kind !== 'create') {
            const task = current.get(entry.task_id);
            if (!task || !task.can_edit) throw new AuthorizationError('当前无权修改所选任务');
            if (localFingerprint(task) !== entry.localSignature) throw new ConflictError('VERSION_CONFLICT', '本地任务已变化，请重新扫描');
          }
          if (entry.kind === 'delete') {
            if (entry.delete_reason !== 'disabled') await assertMissing(entry.schedule_uuid);
            mutations.push({ type: 'delete', id: entry.task_id, version: entry.version });
            continue;
          }
          const plan = await readPlan(entry.schedule_uuid);
          if (sourceFingerprint(plan) !== entry.sourceSignature) throw new ConflictError('UPSTREAM_CHANGED', '影刀计划已变化，请重新扫描');
          const metadata = { schedule_uuid: plan.schedule_uuid, expression: plan.defaults.expression, dispatch: plan.dispatch, fetched_at: plan.fetched_at };
          if (entry.kind === 'create') {
            if (tasks.some(task => task.schedule_uuid === entry.schedule_uuid)) throw new ConflictError('SCHEDULE_ALREADY_BOUND', '该计划已被其他本地任务绑定，请重新扫描');
            const { parseSyncCreateForm } = require('./taskValidation.cjs');
            const input = parseSyncCreateForm(bulk_create ? {
              task: plan.schedule_name, tags: plan.defaults.tags, note: '', expected_duration_seconds: durations.get(entry.id),
            } : form);
            const tempId = `sync:${entry.id}`;
            const seconds = input.expected_duration_seconds;
            if (plan.defaults.timing_mode === 'single' && seconds >= 86400) throw new ValidationError('常规任务时长必须小于24小时');
            mutations.push({ type: 'create', temp_id: tempId, schedule_uuid: entry.schedule_uuid,
              task: input.task, start: plan.defaults.start, finish: suggestedFinish(plan.defaults.start, seconds),
              bot: plan.dispatch.clients[0].name.split('@')[0], tags: input.tags, note: input.note,
              timing_mode: plan.defaults.timing_mode, expected_duration_seconds: seconds });
            syncPlans.set(tempId, metadata);
          } else {
            const task = current.get(entry.task_id), ignored = ignoredFields(entry, rules);
            if (entry.fields.every(item => ignored.includes(item.field))) throw new ConflictError('SCAN_CHANGED', '所选差异已全部加入白名单，请刷新结果');
            const changes = Object.fromEntries(Object.entries(entry.changes).filter(([field]) => !ignored.includes(field)));
            // Metadata-only updates require a harmless field for strict batch validation.
            if (!Object.keys(changes).length) changes.timing_mode = task.timing_mode;
            if (ignored.includes('schedule_dispatch')) metadata.dispatch = task.schedule_dispatch || {};
            if (ignored.includes('schedule_cron_expression')) metadata.expression = task.schedule_cron_expression || null;
            if ((changes.timing_mode || task.timing_mode) === 'cron') {
              try { parseYingdaoCron(metadata.expression); }
              catch { throw new ValidationError('白名单保留的循环规则与任务类型不兼容，请先调整白名单'); }
            }
            mutations.push({ type: 'update', id: entry.task_id, version: entry.version, changes });
            syncPlans.set(entry.task_id, metadata);
          }
        }
        if (now() > job.expires) throw new ConflictError('SCAN_EXPIRED', '扫描结果已过期，请重新扫描');
        assertHeld?.();
        const selectedIds = new Set(selected.map(entry => entry.id));
        const appliedJob = { ...job, entries: job.entries.map(entry => selectedIds.has(entry.id) ? { ...entry, applied: true } : entry) };
        const result = await taskMutationService.applyBatch(actor, { mutations }, { syncPlans,
          beforeCommit: executor => stateRepository.save(appliedJob, { executor }),
        });
        for (const entry of selected) entry.applied = true;
        return { ...result, ...(bulk_create ? { message: `已新增 ${selected.length} 个任务${durationFallbackCount ? `，其中 ${durationFallbackCount} 个无有效历史记录，耗时使用1分钟` : ''}`, duration_fallback_count: durationFallbackCount } : {}),
          affected_ids: [...selected.map(entry => entry.task_id).filter(Boolean), ...Object.values(result.id_map || {})] };
      });
      } finally { job.applying = false; }
    },
  };
  return service;
}

module.exports = { createScheduleReconciliation, differences, canonicalDispatch };
