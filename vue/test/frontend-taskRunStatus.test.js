// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { taskRunIndicators } from '../shared/taskRunIndicators.mjs'
import { useRunStatusPreference, useTodayRunStatus, formatTodayRunStatus, formatDisabledRunStatus } from '../src/services/taskRunStatus.js'
vi.mock('../src/services/apiClient.js', () => ({ apiRequest: vi.fn(), toQuery: params => `?${new URLSearchParams(params)}` }))
import { apiRequest } from '../src/services/apiClient.js'
const task = { id: '1', schedule_uuid: 'plan', schedule_bound_at: '2026-11-01T00:00:00Z', start: '00:00:00', timing_mode: 'cron', schedule_cron_expression: '0 0-8/2 * * *' }
const metadata = { ...task, state: 'ready' }
const record = (hour, status, extra = {}) => ({ task_id: '1', schedule_uuid: 'plan', trigger_time: `2026-11-13T${String(hour).padStart(2, '0')}:00:07+08:00`, status, ...extra })
const payload = records => ({ date: '2026-11-13', tasks: [metadata], records })
beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); apiRequest.mockReset() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it('关闭时只展示成功配置快照的时间，执行同步和扫描开始时间不能冒充配置缓存', () => {
  expect(formatDisabledRunStatus({ state: 'ready', scanned_at: '2026-11-13T05:52:56Z' })).toContain('计划配置缓存截至 11/13 13:52:56')
  expect(formatDisabledRunStatus({ timestamp: '2026-11-13T05:52:56Z' })).toContain('暂无有效计划配置缓存')
  expect(formatDisabledRunStatus({ state: 'scanning', started_at: '2026-11-13T05:52:56Z' })).toContain('暂无有效计划配置缓存')
  expect(formatDisabledRunStatus(null)).toContain('暂无有效计划配置缓存')
  expect(apiRequest).not.toHaveBeenCalled()
})
it('页头计数包含排队与读取中的计划，使用原采集时间，完成和失败分别提示', () => {
  const rows = [{ state: 'ready', fetched_at: '2026-11-13T05:52:56Z' }, ...Array.from({ length: 21 }, () => ({ state: 'loading' }))]
  expect(formatTodayRunStatus({ date: '2026-11-13', tasks: rows })).toContain('数据截至 13:52:56 · 正在更新 21 个计划')
  expect(formatTodayRunStatus({ date: '2026-11-13', tasks: [{ state: 'error' }] })).toContain('1 个计划读取失败')
  expect(formatTodayRunStatus({ date: '2026-11-13', tasks: [{ state: 'ready' }] })).toContain('每60秒核对未成功计划')
})
it('每次触发分别匹配，长任务按触发而非结束匹配，重试最终成功显示绿色', () => {
  const indicate = taskRunIndicators(task, payload([record(0, '运行失败'), record(2, '运行成功', { end_time: '2026-11-13T07:00:00+08:00', error_remark: '重试' }), record(4, '等待中'), record(6, '运行中')]))
  expect(indicate(0).background).toContain('#e34d59')
  expect(indicate(7200).background).toContain('#22a35a')
  expect(indicate(14400).background).toContain('#3b82f6')
  expect(indicate(21600).background).toContain('#3b82f6')
  expect(indicate(28800).hint).toContain('未运行')
  expect(indicate(0, 28800).background).toContain('80% 100%')
  expect(indicate(0, 28800).hint).toContain('运行成功 1 次')
})
it('跨日、其他任务和旧绑定不能着色，读取失败不冒充未运行', () => {
  const data = payload([record(0, '运行成功', { trigger_time: '2026-11-12T15:59:59Z' }), record(2, '运行成功', { schedule_uuid: 'old' }), record(4, '运行成功', { task_id: '2' })])
  expect(taskRunIndicators(task, data)(0, 28800).background).not.toContain('#22a35a')
  expect(taskRunIndicators({ ...task, schedule_uuid: 'new' }, data)(0).hint).toContain('绑定已变化')
  data.tasks[0] = { ...metadata, state: 'error', error: '读取失败' }
  expect(taskRunIndicators(task, data)(0).hint).toContain('读取失败')
  expect(taskRunIndicators(task, data)(0).hint).not.toContain('未运行')
})
it('共享任务只给实际执行机器着色，缺机器信息明确无法匹配', () => {
  const shared = { ...task, shared_candidate: true, candidate_client: { id: 'a' } }
  expect(taskRunIndicators(shared, payload([record(0, '运行成功', { client_ids: ['a'] })]))(0).background).toContain('#22a35a')
  expect(taskRunIndicators(shared, payload([record(0, '运行成功', { client_ids: ['b'] })]))(0).hint).toContain('尚未执行')
  expect(taskRunIndicators(shared, payload([record(0, '运行成功', { client_ids: [] })]))(0).hint).toContain('无法匹配')
})
it('默认关闭，通过Cookie长期保存，与登录偏好独立', () => {
  document.cookie = 'pytaskgantt.showRunStatus=; Max-Age=0; Path=/'
  const preference = useRunStatusPreference()
  expect(preference.enabled.value).toBe(false)
  preference.save(true)
  expect(useRunStatusPreference().enabled.value).toBe(true)
  preference.save(false)
})

function monitor(enabled = ref(true), rows = ref([task])) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T04:00:00Z'))
  let state
  const wrapper = mount({ setup() { state = useTodayRunStatus(enabled, rows); return () => null } })
  return { wrapper, state, enabled, rows }
}
it('关闭不请求，首次开启强制核对，之后60秒核对，取消后忽略旧响应', async () => {
  apiRequest.mockResolvedValue(payload([]))
  const view = monitor(ref(false), ref([task, task, { id: 'tmp:1', schedule_uuid: 'other' }]))
  expect(apiRequest).not.toHaveBeenCalled()
  view.enabled.value = true; await nextTick(); await flushPromises()
  expect(apiRequest.mock.calls[0][0]).toContain('task_ids=1&refresh=force&refresh_ids=1')
  await vi.advanceTimersByTimeAsync(59999); expect(apiRequest).toHaveBeenCalledTimes(1)
  let resolve
  apiRequest.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await vi.advanceTimersByTimeAsync(1)
  expect(apiRequest.mock.calls[1][0]).toContain('refresh=due')
  const signal = apiRequest.mock.calls[1][1].signal
  view.enabled.value = false; await nextTick(); expect(signal.aborted).toBe(true)
  resolve({ date: 'stale' }); await flushPromises()
  expect(view.state.data.value.date).toBe('2026-11-13')
  await vi.advanceTimersByTimeAsync(120000); expect(apiRequest).toHaveBeenCalledTimes(2)
  view.wrapper.unmount()
})
it('后台停止请求，激活后重新等满60秒，连续焦点事件不留下重复计时器', async () => {
  apiRequest.mockResolvedValue(payload([]))
  const view = monitor(); await flushPromises()
  window.dispatchEvent(new Event('blur'))
  await vi.advanceTimersByTimeAsync(120000); expect(apiRequest).toHaveBeenCalledTimes(1)
  expect(view.state.data.value.monitor.paused).toBe(true)
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(59999); expect(apiRequest).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(apiRequest).toHaveBeenCalledTimes(2)
  view.wrapper.unmount(); expect(vi.getTimerCount()).toBe(0)
})
it('页面初始未激活不请求，激活60秒后首次强制核对', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  apiRequest.mockResolvedValue(payload([]))
  const view = monitor(); await flushPromises()
  expect(apiRequest).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(60000)
  expect(apiRequest.mock.calls[0][0]).toContain('refresh=force')
  view.wrapper.unmount()
})
it('处理中15秒只读缓存；循环任务任一次成功后停止，重新打开才强制核对', async () => {
  const success = payload([record(0, '运行成功')])
  apiRequest.mockResolvedValueOnce({ ...success, tasks: [{ ...metadata, state: 'loading' }] }).mockResolvedValue(success)
  const view = monitor(); await flushPromises()
  await vi.advanceTimersByTimeAsync(15000)
  expect(apiRequest.mock.calls[1][0]).toContain('refresh=cache')
  expect(view.state.data.value.monitor.stopped_success_count).toBe(1)
  await vi.advanceTimersByTimeAsync(180000); expect(apiRequest).toHaveBeenCalledTimes(2)
  window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(60000); expect(apiRequest).toHaveBeenCalledTimes(2)
  view.wrapper.unmount()
  const reopened = monitor(); await flushPromises()
  expect(apiRequest.mock.calls[2][0]).toContain('refresh=force')
  reopened.wrapper.unmount()
})
it('成功与未成功计划混合时，只核对未成功的计划', async () => {
  const second = { ...task, id: '2', schedule_uuid: 'other' }
  apiRequest.mockResolvedValue({ ...payload([record(0, '运行成功')]), tasks: [metadata, { ...second, state: 'ready' }] })
  const view = monitor(ref(true), ref([task, second])); await flushPromises()
  await vi.advanceTimersByTimeAsync(60000)
  const params = new URLSearchParams(apiRequest.mock.calls[1][0].split('?')[1])
  expect(params.get('refresh_ids')).toBe('2'); expect(params.get('task_ids')).toBe('1,2')
  view.wrapper.unmount()
})

it('标签页隐藏时暂停，恢复可见后从60秒重新计时', async () => {
  apiRequest.mockResolvedValue(payload([]))
  const view = monitor(); await flushPromises()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(90000); expect(apiRequest).toHaveBeenCalledTimes(1)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(59999); expect(apiRequest).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(apiRequest).toHaveBeenCalledTimes(2)
  view.wrapper.unmount()
})
it('首次强制核对失败后仍按强制模式重试，不用旧成功记录跳过核对', async () => {
  apiRequest.mockRejectedValueOnce(new Error('network')).mockResolvedValue(payload([]))
  const view = monitor(); await flushPromises()
  await vi.advanceTimersByTimeAsync(60000)
  expect(apiRequest.mock.calls[1][0]).toContain('refresh=force')
  view.wrapper.unmount()
})
