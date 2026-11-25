import { computed, reactive, readonly } from 'vue'
import { reconciliationFields, ruleKey, visibleEntries, ignoredFields } from '../../shared/reconciliationPolicy.mjs'
import { startPlanScan, getPlanSyncState, changePlanWhitelist, restorePlanWhitelist, recheckPlanEntries } from '../services/scheduleReconciliationService.js'

const AUTO_INTERVAL = 30 * 60 * 1000
export const fieldLabels = { plan: '新增提醒（整个计划）', task: '任务名称', bot: '机器人', timing_mode: '任务类型', start: '开始时间', finish: '结束时间', schedule_dispatch: '机器与执行策略', schedule_cron_expression: '循环规则' }
export function createPlanSyncStore({ start = startPlanScan, getState = getPlanSyncState, changeRule = changePlanWhitelist,
  restoreRules = restorePlanWhitelist, recheck = recheckPlanEntries,
  now = Date.now, storage = () => globalThis.localStorage, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const state = reactive({ userId: null, job: null, result: null, error: '', running: false, unread: false,
    initializing: false, lastCheckedAt: 0, seenScanId: null, whitelist: [] })
  const entries = computed(() => visibleEntries(state.result?.entries, state.whitelist))
  let generation = 0, timer = null, refreshing = false
  const key = () => `pytaskgantt.planSync.v1:${state.userId}`
  function persistReadState() {
    if (!state.userId) return
    // Results and policy belong to PostgreSQL; only the user's read receipt is local.
    try { storage()?.setItem(key(), JSON.stringify({ seenScanId: state.seenScanId, unread: state.unread })) } catch {}
  }
  function stop() { cancel(timer); timer = null }
  function poll() {
    stop()
    if (state.userId) timer = schedule(() => { void refresh() }, state.running ? 1500 : 15000)
  }
  function updateUnread() {
    const failed = state.job?.state === 'failed'
    const id = failed ? state.job.id : state.result?.id
    state.unread = Boolean((failed || entries.value.length) && (state.unread || id !== state.seenScanId))
  }
  function accept(payload) {
    const previousId = state.result?.id
    const previous = new Set(entries.value.flatMap(row => row.kind === 'update' ? row.fields.map(field => `${row.id}:${field.field}`) : [row.id]))
    state.job = payload.job || null
    state.result = payload.result || null
    state.whitelist = (payload.whitelist || []).map(rule => ({ ...rule, key: ruleKey(rule, rule.field), label: fieldLabels[rule.field] || rule.field }))
    state.running = state.job?.state === 'scanning'
    state.error = state.job?.state === 'failed' ? state.job.error : ''
    const last = state.job || state.result
    state.lastCheckedAt = Date.parse(last?.scanned_at || last?.started_at) || 0
    updateUnread()
    if (previousId && previousId === state.result?.id && entries.value.some(row => row.kind === 'update'
      ? row.fields.some(field => !previous.has(`${row.id}:${field.field}`)) : !previous.has(row.id))) state.unread = true
    persistReadState()
  }
  function failed(error) {
    state.running = false
    state.error = error.message || '无法读取同步状态，请稍后重试'
    state.unread = true
    persistReadState()
  }
  async function refresh({ automatic = false } = {}) {
    if (!state.userId || refreshing) return
    const token = generation
    refreshing = true
    try {
      const payload = await getState()
      if (token !== generation) return
      accept(payload)
      state.initializing = false
      refreshing = false
      if (automatic && !state.running && (!state.lastCheckedAt || now() - state.lastCheckedAt >= AUTO_INTERVAL)) return scan()
      poll()
    } catch (error) {
      if (token === generation) { failed(error); poll() }
    } finally {
      if (token === generation) { refreshing = false; state.initializing = false }
    }
  }
  async function scan() {
    if (!state.userId || state.running || state.initializing) return
    const token = ++generation
    refreshing = false
    stop()
    state.running = true
    state.error = ''
    try {
      const job = await start()
      if (token !== generation) return
      state.job = job
      state.running = job.state === 'scanning'
      state.lastCheckedAt = Date.parse(job.scanned_at || job.started_at) || now()
      if (job.state === 'ready') state.result = job
      if (job.state === 'failed') state.error = job.error
      updateUnread()
      persistReadState()
      poll()
    } catch (error) { if (token === generation) { failed(error); poll() } }
  }
  function connectUser(userId) {
    const id = userId == null ? null : String(userId)
    if (state.userId === id) return
    generation++
    stop()
    refreshing = false
    Object.assign(state, { userId: id, job: null, result: null, error: '', running: false, unread: false,
      initializing: Boolean(id), lastCheckedAt: 0, seenScanId: null, whitelist: [] })
    if (!id) return
    try {
      const cached = JSON.parse(storage()?.getItem(key()) || 'null')
      state.seenScanId = typeof cached?.seenScanId === 'string' ? cached.seenScanId : null
      state.unread = Boolean(cached?.unread)
    } catch {}
    void refresh({ automatic: true })
  }
  function markRead() {
    if (state.initializing || (state.running && !state.result)) return
    state.seenScanId = (!state.running && state.job?.state === 'failed' ? state.job.id : state.result?.id) || null
    state.unread = false
    persistReadState()
  }
  async function mutateRule(row, field, remove) {
    const token = generation
    const payload = await changeRule({ task_id: row.task_id == null ? null : String(row.task_id), schedule_uuid: row.schedule_uuid, field }, remove)
    if (token === generation) accept(payload)
  }
  async function ignoreField(row, field) {
    if (row.kind === 'create' && row.schedule_uuid && field.field === 'plan') return mutateRule(row, 'plan', false)
    if (row.kind !== 'update' || !row.task_id || !row.schedule_uuid || !reconciliationFields.includes(field.field)) return
    await mutateRule(row, field.field, false)
  }
  async function restoreIgnored(rule) { await mutateRule(rule, rule.field, true) }
  async function restoreIgnoredMany(rules) {
    const token = generation
    const payload = await restoreRules(rules.map(rule => ({ task_id: rule.task_id == null ? null : String(rule.task_id), schedule_uuid: rule.schedule_uuid, field: rule.field })))
    if (token === generation) accept(payload)
  }
  async function recheckEntries(id, entryIds) {
    const token = generation
    const payload = await recheck(id, entryIds)
    if (token === generation) accept(payload)
  }
  return { state: readonly(state), entries, connectUser, scan, refresh, refreshResult: refresh, markRead,
    ignoreField, restoreIgnored, restoreIgnoredMany, recheckEntries, ignoredFields: row => ignoredFields(row, state.whitelist) }
}
export const planSyncStore = createPlanSyncStore()
