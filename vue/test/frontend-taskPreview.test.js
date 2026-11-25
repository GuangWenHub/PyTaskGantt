import { describe, expect, it, vi } from 'vitest'
import { createTaskDraftStore } from '../src/stores/taskDraftStore.js'

const row = { id: '1', version: 1, can_edit: true, schedule_uuid: 'schedule-a', task: '任务', bot: 'A', start: '23:30:00', finish: '00:10:00', tags: [], schedule_cron_expression: '*/10 * * * *' }
function setup() {
  const loader = vi.fn(async () => ({ tasks: [{ ...row }], serverTime: 'new' }))
  const saver = vi.fn()
  const store = createTaskDraftStore(loader, saver, { previewOnly: true })
  store._hydrateForTest([row])
  return { store, loader, saver }
}

describe('甘特图临时预览', () => {
  it('仅改候选机器也标红，轮询保留候选投影，刷新恢复且不写接口', async () => {
    const { store, saver } = setup()
    const dispatch = { execute_scope: 'any', client_scope: 'assign', clients: [{ id: 'preview:A', name: 'A' }, { id: 'preview:B', name: 'B' }] }
    store.updateTask('1', { schedule_dispatch: dispatch })
    expect(store.tasks.value[0]._preview_modified).toBe(true)
    await store.load({ preserveDraft: true })
    expect(store.tasks.value[0].schedule_dispatch.clients).toHaveLength(2)
    await store.load({ preserveDraft: false })
    expect(store.tasks.value[0].schedule_dispatch).toEqual({})
    expect(store.tasks.value[0]._preview_modified).toBe(false)
    expect(saver).not.toHaveBeenCalled()
  })
  it('调整跨天时间仅影响预览，不暴露保存入口或产生待保存状态；还原原值后红框消失', () => {
    const { store, saver } = setup()
    store.updateTask('1', { start: '23:40:00', finish: '00:20:00' })
    expect(store.save).toBeUndefined()
    expect(store.hasUnsaved.value).toBe(false)
    expect(store.hasPreviews.value).toBe(true)
    expect(store.isDirty('1')).toBe(false)
    expect(store.tasks.value[0]).toMatchObject({ start: '23:40:00', finish: '00:20:00', _preview_modified: true })
    store.updateTask('1', { start: row.start, finish: row.finish })
    expect(store.tasks.value[0]._preview_modified).toBe(false)
    expect(saver).not.toHaveBeenCalled()
  })

  it('轮询保留预览时间和循环规则，更新运行状态；同步后可清除单条预览', async () => {
    const { store, loader } = setup()
    store.updateTask('1', { finish: '01:00:00', schedule_cron_expression: '*/20 * * * *' })
    loader.mockResolvedValue({ tasks: [{ ...row, normalized_status: '执行中', version: 2 }] })
    await store.load({ preserveDraft: true })
    expect(store.tasks.value[0]).toMatchObject({ finish: '01:00:00', schedule_cron_expression: '*/20 * * * *', normalized_status: '执行中', _preview_modified: true })
    store.clearPreview('1')
    expect(store.tasks.value[0]).toMatchObject({ finish: row.finish, schedule_cron_expression: row.schedule_cron_expression, version: 2, _preview_modified: false })
  })

  it('刷新清除新增、编辑和删除预览，始终不调用写接口', async () => {
    const { store, saver } = setup()
    store.addTask({ ...row, task: '临时新任务' })
    store.deleteTask('1')
    await store.load({ preserveDraft: false })
    expect(store.tasks.value).toHaveLength(1)
    expect(store.hasPreviews.value).toBe(false)
    expect(store.tasks.value[0]._preview_modified).toBe(false)
    expect(saver).not.toHaveBeenCalled()
  })

  it('绑定或编辑权限变化后不继续展示旧预览', async () => {
    const { store, loader } = setup()
    store.updateTask('1', { note: '预览备注' })
    loader.mockResolvedValue({ tasks: [{ ...row, schedule_uuid: 'schedule-b' }] })
    await store.load({ preserveDraft: true })
    expect(store.tasks.value[0]).toMatchObject({ schedule_uuid: 'schedule-b', note: '', _preview_modified: false })
  })
})
