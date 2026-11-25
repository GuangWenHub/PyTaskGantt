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
  if (payload.error) return payload.error
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
  let requestTimeout = null
  let nextCheckAt = 0, forcePending = true
  let day = shanghaiDay()
  const successful = new Set()
  const ids = () => [...new Set(tasks.value.filter(task => /^[1-9]\d*$/.test(String(task.id)) && task.schedule_uuid).map(task => String(task.id)))].sort()
  const bindingKey = task => `${day}:${task.id}:${task.schedule_uuid}:${task.schedule_bound_at}`
  function shanghaiDay() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) }
  function updateDay() {
    const current = shanghaiDay()
    if (current === day) return false
    day = current
    successful.clear()
    forcePending = true
    return true
  }
  function stopped(id) { const task = tasks.value.find(task => String(task.id) === id); return task && successful.has(bindingKey(task)) }
  function publish(payload = data.value) {
    data.value = { ...payload, monitor: { stopped_success_count: ids().filter(stopped).length } }
  }
  function cancel() {
    generation++
    clearTimeout(timer)
    clearTimeout(midnightTimer)
    clearTimeout(requestTimeout)
    controller?.abort()
    timer = midnightTimer = requestTimeout = controller = null
  }
  function schedule() {
    clearTimeout(timer); clearTimeout(midnightTimer)
    if (!enabled.value) return
    const loading = data.value.tasks?.some(task => task.state === 'loading')
    if (loading || ids().some(id => !stopped(id))) {
      const due = Math.max(0, nextCheckAt - Date.now())
      timer = setTimeout(() => { void refresh(Date.now() >= nextCheckAt ? (forcePending ? 'force' : 'due') : 'cache', generation) }, Math.max(50, loading ? Math.min(15000, due) : due))
    }
    const tomorrow = Date.parse(`${day}T00:00:00+08:00`) + 86400000
    midnightTimer = setTimeout(() => { updateDay(); nextCheckAt = Date.now(); void refresh('force', generation) }, Math.max(50, tomorrow - Date.now()))
  }
  async function refresh(mode, token) {
    if (!enabled.value || token !== generation || controller) return
    if (updateDay()) mode = 'force'
    const all = ids(), refreshIds = mode === 'force' ? all : mode === 'due' ? all.filter(id => !stopped(id)) : []
    if (!all.length) { data.value = {}; error.value = ''; schedule(); return }
    if (mode !== 'cache' && !refreshIds.length) { schedule(); return }
    clearTimeout(timer)
    clearTimeout(midnightTimer)
    if (mode !== 'cache') nextCheckAt = Date.now() + 60000
    const request = new AbortController()
    controller = request
    let timedOut = false
    requestTimeout = setTimeout(() => {
      timedOut = true
      request.abort()
    }, 15000)
    try {
      const payload = await apiRequest(`/tasks/today-executions${toQuery({ task_ids: all.join(','), refresh: mode, ...(refreshIds.length ? { refresh_ids: refreshIds.join(',') } : {}) })}`, { signal: request.signal })
      if (token !== generation) return
      if (mode === 'force') forcePending = false
      // A successful cached record cannot stop a newly requested check while its metadata is still loading/error.
      for (const metadata of payload.tasks || []) {
        const task = tasks.value.find(task => String(task.id) === String(metadata.id))
        if (!forcePending && payload.date === day && task && metadata.state === 'ready' && metadata.schedule_uuid === task.schedule_uuid
          && String(metadata.schedule_bound_at) === String(task.schedule_bound_at)
          && payload.records?.some(row => String(row.task_id) === String(task.id) && row.schedule_uuid === task.schedule_uuid && row.status === '运行成功')) successful.add(bindingKey(task))
      }
      publish(payload); error.value = ''
    } catch (failure) {
      if (token === generation && (timedOut || failure.name !== 'AbortError')) {
        error.value = timedOut ? '读取今日运行记录超时，稍后自动重试' : failure.message
        publish({ ...data.value, error: error.value })
      }
    } finally {
      if (token === generation) {
        clearTimeout(requestTimeout)
        requestTimeout = controller = null
        schedule()
      }
    }
  }
  function catchUp() {
    if (!enabled.value || document.visibilityState !== 'visible' || controller) return
    if (shanghaiDay() !== day) void refresh('force', generation)
    else if (Date.now() >= nextCheckAt && ids().some(id => !stopped(id))) {
      void refresh(forcePending ? 'force' : 'due', generation)
    }
  }
  window.addEventListener('focus', catchUp)
  document.addEventListener('visibilitychange', catchUp)
  watch([enabled, () => tasks.value.map(task => `${task.id}:${task.schedule_uuid}:${task.schedule_bound_at}`).sort().join('|')], () => {
    cancel(); updateDay(); publish()
    if (!enabled.value) return
    if (!ids().length) { data.value = {}; return }
    void refresh(forcePending ? 'force' : 'cache', generation)
  }, { immediate: true })
  onBeforeUnmount(() => {
    cancel()
    window.removeEventListener('focus', catchUp)
    document.removeEventListener('visibilitychange', catchUp)
  })
  function refreshNow() {
    if (!enabled.value) return
    cancel()
    successful.clear()
    forcePending = true
    publish()
    return refresh('force', generation)
  }
  return { data, error, refreshNow }
}
