import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { apiRequest, toQuery } from './apiClient.js'
import { readDisplayPreference, saveDisplayPreference } from './browserPreferences.js'
const COOKIE = 'pytaskgantt.showRunStatus'
export function formatDisabledRunStatus(snapshot = {}) {
  const time = Date.parse(snapshot?.state === 'ready' ? snapshot.scanned_at || '' : '')
  const cached = Number.isFinite(time) ? `计划配置缓存截至 ${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(time))}` : '暂无有效计划配置缓存'
  return cached
}
export function formatTodayRunStatus(payload = {}, hasTasks = true) {
  if (payload.monitor?.paused) return '今日定时运行状态 · 网页未激活，已暂停核对'
  if (payload.error) return payload.error
  if (payload.monitor?.waiting) return `今日定时运行状态 · 下次核对 ${new Date(payload.monitor.next_check_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
  if (!hasTasks) return '暂无符合条件的任务'
  if (!payload.date) return '正在读取今日运行记录…'
  const metadata = payload.tasks || []
  const loading = metadata.filter(row => row.state === 'loading').length
  const failed = metadata.filter(row => row.state === 'error').length
  const fetched = metadata.map(row => row.fetched_at).filter(Boolean).sort()[0]
  const time = fetched ? new Date(fetched).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : ''
  return `${payload.date} 今日定时运行状态${time ? ` · 数据截至 ${time}` : ''} · ${loading ? `正在更新 ${loading} 个计划` : failed ? `${failed} 个计划读取失败，稍后重试` : metadata.length && payload.monitor?.stopped_success_count === metadata.length ? '成功计划已停止核对，刷新或重开后再查' : '每60秒核对未成功计划'}`
}
export function useRunStatusPreference() {
  const enabled = ref(readDisplayPreference(COOKIE))
  function save(value = enabled.value) {
    enabled.value = Boolean(value)
    saveDisplayPreference(COOKIE, enabled.value)
  }
  save()
  return { enabled, save }
}
export function useTodayRunStatus(enabled, tasks) {
  const data = shallowRef({}), error = ref('')
  let timer = null, midnightTimer = null, controller = null, generation = 0
  let windowFocused = document.hasFocus(), nextCheckAt = 0, initialized = false, forcePending = true, waiting = false
  let day = shanghaiDay()
  const successful = new Set()
  const ids = () => [...new Set(tasks.value.filter(task => /^[1-9]\d*$/.test(String(task.id)) && task.schedule_uuid).map(task => String(task.id)))].sort()
  const active = () => document.visibilityState === 'visible' && windowFocused
  const bindingKey = task => `${day}:${task.id}:${task.schedule_uuid}:${task.schedule_bound_at}`
  function shanghaiDay() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) }
  function updateDay() {
    const current = shanghaiDay()
    if (current !== day) { day = current; successful.clear(); forcePending = true }
  }
  function stopped(id) { const task = tasks.value.find(task => String(task.id) === id); return task && successful.has(bindingKey(task)) }
  function publish(payload = data.value) {
    data.value = { ...payload, monitor: { paused: enabled.value && !active(), waiting, next_check_at: nextCheckAt, stopped_success_count: ids().filter(stopped).length } }
  }
  function cancel() { generation++; clearTimeout(timer); clearTimeout(midnightTimer); controller?.abort(); timer = null; midnightTimer = null }
  function schedule() {
    clearTimeout(timer); clearTimeout(midnightTimer)
    if (!enabled.value || !active()) return
    const loading = data.value.tasks?.some(task => task.state === 'loading')
    if (loading || ids().some(id => !stopped(id))) {
      const due = Math.max(0, nextCheckAt - Date.now())
      timer = setTimeout(() => { void refresh(Date.now() >= nextCheckAt ? (forcePending ? 'force' : 'due') : 'cache', generation) }, Math.max(50, loading ? Math.min(15000, due) : due))
    }
    const tomorrow = Date.parse(`${day}T00:00:00+08:00`) + 86400000
    midnightTimer = setTimeout(() => { updateDay(); nextCheckAt = Date.now(); void refresh('force', generation) }, Math.max(50, tomorrow - Date.now()))
  }
  async function refresh(mode, token) {
    if (!enabled.value || !active() || token !== generation) return
    updateDay()
    const all = ids(), refreshIds = mode === 'force' ? all : mode === 'due' ? all.filter(id => !stopped(id)) : []
    if (!all.length) { data.value = {}; error.value = ''; schedule(); return }
    if (mode !== 'cache' && !refreshIds.length) { schedule(); return }
    if (mode !== 'cache') { nextCheckAt = Date.now() + 60000; waiting = false }
    controller = new AbortController()
    try {
      const payload = await apiRequest(`/tasks/today-executions${toQuery({ task_ids: all.join(','), refresh: mode, ...(refreshIds.length ? { refresh_ids: refreshIds.join(',') } : {}) })}`, { signal: controller.signal })
      if (token !== generation) return
      if (mode === 'force') forcePending = false
      // A successful cached record cannot stop a newly requested check while its metadata is still loading/error.
      for (const metadata of payload.tasks || []) {
        const task = tasks.value.find(task => String(task.id) === String(metadata.id))
        if (!forcePending && payload.date === day && task && metadata.state === 'ready' && metadata.schedule_uuid === task.schedule_uuid
          && String(metadata.schedule_bound_at) === String(task.schedule_bound_at)
          && payload.records?.some(row => String(row.task_id) === String(task.id) && row.schedule_uuid === task.schedule_uuid && row.status === '运行成功')) successful.add(bindingKey(task))
      }
      if (ids().every(stopped)) waiting = false
      publish(payload); error.value = ''
    } catch (failure) {
      if (token === generation && failure.name !== 'AbortError') { error.value = failure.message; publish({ ...data.value, error: failure.message }) }
    } finally { if (token === generation) schedule() }
  }
  function resume() {
    cancel(); updateDay(); waiting = ids().some(id => !stopped(id)) || Boolean(data.value.tasks?.some(task => task.state === 'loading')); nextCheckAt = Date.now() + 60000; publish(); schedule()
  }
  function focus() { windowFocused = true; if (enabled.value && document.visibilityState === 'visible') resume() }
  function blur() { windowFocused = false; cancel(); publish() }
  function visibility() { if (document.visibilityState === 'visible') { windowFocused = document.hasFocus(); if (active() && enabled.value) resume() } else { cancel(); publish() } }
  window.addEventListener('focus', focus); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility)
  watch([enabled, () => tasks.value.map(task => `${task.id}:${task.schedule_uuid}:${task.schedule_bound_at}`).sort().join('|')], () => {
    cancel(); updateDay(); publish()
    if (!enabled.value) return
    if (!ids().length) { data.value = {}; return }
    if (!initialized) {
      initialized = true
      if (active()) { nextCheckAt = Date.now(); void refresh('force', generation) } else { waiting = true; publish() }
    } else if (active()) { waiting = ids().some(id => !stopped(id)); nextCheckAt = Date.now() + 60000; void refresh('cache', generation) }
  }, { immediate: true })
  onBeforeUnmount(() => { cancel(); window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility) })
  return { data, error }
}
