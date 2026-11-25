// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlanSyncStore } from '../src/stores/planSyncStore.js'

describe('数据库共享扫描缓存与白名单', () => {
  let time, start, getState, changeRule, store, database
  const entry = { id: 'e1', task_id: '1', schedule_uuid: 'a', name: '任务', kind: 'update', fields: [
    { field: 'task', label: '任务名称', local: '本地', remote: '影刀' },
    { field: 'start', label: '开始时间', local: '09:00', remote: '10:00' },
  ] }
  function ready(id = 's1', entries = [entry]) { return { id, state: 'ready', scanned_at: new Date(time).toISOString(), entries } }
  function make() { return createPlanSyncStore({ start, getState, changeRule, now: () => time }) }
  beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear()
    time = Date.parse('2026-11-06T00:00:00Z')
    const job = ready()
    database = { job, result: job, whitelist: [] }
    start = vi.fn(async () => { database.job = { id: 's2', state: 'scanning', started_at: new Date(time).toISOString(), entries: [] }; return database.job })
    getState = vi.fn(async () => structuredClone(database))
    changeRule = vi.fn(async (rule, remove) => {
      database.whitelist = remove ? database.whitelist.filter(item => item.field !== rule.field) : [...database.whitelist, { ...rule, can_edit: true }]
      return structuredClone(database)
    })
    store = make()
  })
  afterEach(() => { store.connectUser(null); vi.useRealTimers() })
  it('登录先读数据库，30分钟内直接展示跨账号共享结果，不扫描', async () => {
    store.connectUser('1'); await flushPromises()
    expect(store.state.result.id).toBe('s1')
    expect(start).not.toHaveBeenCalled()
    store.connectUser('2'); await flushPromises()
    expect(store.state.result.id).toBe('s1')
    expect(store.state.unread).toBe(true)
    expect(start).not.toHaveBeenCalled()
  })
  it('已读回执按账号隔离；重开浏览器从数据库恢复结果', async () => {
    store.connectUser('1'); await flushPromises(); store.markRead(); store.connectUser(null)
    store = make(); store.connectUser('1'); await flushPromises()
    expect(store.state.unread).toBe(false)
    expect(store.state.result.id).toBe('s1')
    expect(JSON.parse(localStorage.getItem('pytaskgantt.planSync.v1:1')).result).toBeUndefined()
    store.connectUser('2'); await flushPromises()
    expect(store.state.unread).toBe(true)
  })
  it('满30分钟才后台扫描，仍保留数据库上次结果；轮询不能重复触发扫描', async () => {
    time += 30 * 60 * 1000 - 1
    store.connectUser('1'); await flushPromises()
    expect(start).not.toHaveBeenCalled()
    time++
    store.connectUser(null); store.connectUser('1'); await flushPromises()
    expect(start).toHaveBeenCalledTimes(1)
    expect(store.state.running).toBe(true)
    expect(store.state.result.id).toBe('s1')
    database.job = database.result = ready('s2')
    await vi.advanceTimersByTimeAsync(1500)
    expect(store.state.result.id).toBe('s2')
    time += 60 * 60 * 1000
    await vi.advanceTimersByTimeAsync(15000)
    expect(start).toHaveBeenCalledTimes(1)
  })
  it('数据库无历史才首次扫描，旧浏览器缓存不作为共享配置或权威结果上传', async () => {
    database = { job: null, result: null, whitelist: [] }
    localStorage.setItem('pytaskgantt.planSync.v1:1', JSON.stringify({ result: ready('legacy'), whitelist: [{ task_id: '1', field: 'task' }] }))
    store.connectUser('1'); await flushPromises()
    expect(start).toHaveBeenCalledTimes(1)
    expect(store.state.result).toBeNull()
    expect(store.state.whitelist).toHaveLength(0)
    expect(changeRule).not.toHaveBeenCalled()
  })
  it('逐属性加入共享白名单，其他属性和其他任务仍提醒；新账号读取同一白名单', async () => {
    store.connectUser('1'); await flushPromises()
    await store.ignoreField(entry, entry.fields[0])
    expect(changeRule).toHaveBeenCalledWith({ task_id: '1', schedule_uuid: 'a', field: 'task' }, false)
    expect(store.entries.value[0].fields.map(field => field.field)).toEqual(['start'])
    store.connectUser('2'); await flushPromises()
    expect(store.entries.value[0].fields.map(field => field.field)).toEqual(['start'])
    await store.ignoreField(entry, entry.fields[1])
    expect(store.entries.value).toHaveLength(0)
    expect(store.state.unread).toBe(false)
    await store.restoreIgnored(store.state.whitelist[0])
    expect(store.entries.value[0].fields[0].field).toBe('task')
    expect(store.state.unread).toBe(true)
  })
  it('15秒轻量刷新能读取其他账号的白名单，不触发影刀全量扫描', async () => {
    store.connectUser('1'); await flushPromises()
    database.whitelist = [{ task_id: '1', schedule_uuid: 'a', field: 'task' }]
    await vi.advanceTimersByTimeAsync(15000)
    expect(store.entries.value[0].fields.map(field => field.field)).toEqual(['start'])
    expect(start).not.toHaveBeenCalled()
  })
  it('白名单按任务ID和绑定UUID隔离，同字段在其他任务或换绑后仍提醒', async () => {
    database.result.entries.push({ ...entry, id: 'e2', task_id: '2' }, { ...entry, id: 'e3', schedule_uuid: 'new-binding' })
    database.whitelist = [{ task_id: '1', schedule_uuid: 'a', field: 'task' }]
    store.connectUser('1'); await flushPromises()
    expect(store.entries.value[0].fields.map(field => field.field)).toEqual(['start'])
    expect(store.entries.value[1].fields.map(field => field.field)).toContain('task')
    expect(store.entries.value[2].fields.map(field => field.field)).toContain('task')
  })
  it('缓存里的旧手动触发错误也忽略；其他未知错误继续提示', async () => {
    database.job = database.result = ready('s1', [
      { id: 'manual', kind: 'error', error: '手动触发计划没有固定排班时刻，请人工安排，不自动覆盖' },
      { id: 'bad', kind: 'error', error: '无效Cron' },
    ])
    store.connectUser('1'); await flushPromises()
    expect(store.entries.value.map(row => row.id)).toEqual(['bad'])
    expect(store.state.unread).toBe(true)
  })
  it('读取或后台扫描失败保留数据库上次结果，不能伪装为无差异', async () => {
    store.connectUser('1'); await flushPromises()
    getState.mockRejectedValue(new Error('数据库读取失败'))
    await store.refresh()
    expect(store.state.result.id).toBe('s1')
    expect(store.state.unread).toBe(true)
    expect(store.state.error).toBe('数据库读取失败')
    expect(start).not.toHaveBeenCalled()
  })
  it('换账号时旧异步请求不能覆盖当前结果，登出停止轮询', async () => {
    let resolveOld
    getState.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    store.connectUser('1'); store.connectUser('2'); await flushPromises()
    resolveOld({ job: ready('old'), result: ready('old'), whitelist: [] }); await flushPromises()
    expect(store.state.result.id).toBe('s1')
    store.connectUser(null)
    const count = getState.mock.calls.length
    await vi.advanceTimersByTimeAsync(30000)
    expect(getState).toHaveBeenCalledTimes(count)
  })
  it('计划白名单共享并只抑制该计划的新增，不抑制同计划已绑定任务的属性差异', async () => {
    const create = { ...entry, id: 'create-a', kind: 'create', task_id: null, fields: [] }
    database.job = database.result = ready('s1', [create])
    store.connectUser('1'); await flushPromises()
    await store.ignoreField(create, { field: 'plan' })
    expect(changeRule).toHaveBeenCalledWith({ task_id: null, schedule_uuid: 'a', field: 'plan' }, false)
    expect(store.entries.value).toHaveLength(0)
    expect(store.state.unread).toBe(false)
    store.connectUser('2'); await flushPromises()
    expect(store.entries.value).toHaveLength(0)
    database.result.entries.push(entry, { ...create, id: 'create-b', schedule_uuid: 'b' })
    await store.refresh()
    expect(store.entries.value.map(row => row.id)).toEqual(['e1', 'create-b'])
  })
})
