// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  list: vi.fn(), annotate: vi.fn(), preview: vi.fn(), restore: vi.fn(),
  success: vi.fn(), error: vi.fn(), warning: vi.fn(),
}))
vi.mock('../src/services/taskHistoryService.js', async importOriginal => ({
  ...(await importOriginal()),
  getTaskHistory: state.list, saveHistoryAnnotation: state.annotate,
  previewHistoryRestore: state.preview, restoreHistory: state.restore,
}))
vi.mock('naive-ui', () => ({
  NCard: { template: '<section><slot name="header-extra"/><slot/></section>' },
  NButton: { props: ['disabled', 'loading'], template: '<button :disabled="disabled || loading"><slot/></button>' },
  NEmpty: { props: ['description'], template: '<div>{{ description }}</div>' },
  NPagination: { props: ['page', 'itemCount', 'pageSize'], emits: ['update:page'], template: '<button @click="$emit(\'update:page\', page + 1)">下一页</button>' },
  NAlert: { template: '<div role="alert"><slot/></div>' },
  NInput: { props: ['value', 'disabled'], emits: ['update:value'], template: '<textarea :value="value" :disabled="disabled" @input="$emit(\'update:value\', $event.target.value)" />' },
  NSelect: { props: ['value', 'options'], emits: ['update:value'], template: '<select :value="value" @change="$emit(\'update:value\', $event.target.value)"><option value="">全部</option><option v-for="option in options" :value="option.value">{{ option.label }}</option></select>' },
  NModal: { props: ['show'], template: '<div v-if="show" role="dialog"><slot/><slot name="footer"/></div>' },
  NSpace: { template: '<div><slot/></div>' },
  useMessage: () => ({ success: state.success, error: state.error, warning: state.warning }),
}))
import TaskHistoryCard from '../src/components/TaskHistoryCard.vue'

const record = {
  id: '10', task_id: '1', task_name: '每日取数', actor_user_id: '7', actor_name: '用户甲', action: 'update',
  before: { task: '每日取数', start: '08:00:00' }, after: { task: '每日取数', start: '07:30:00' },
  snapshot_complete: true, annotation: '', annotation_version: 3,
  can_annotate: true, can_restore: true, created_at: '2026-10-20T02:00:00Z',
}
const preview = { task_id: '1', task_version: 9, current: record.after, target: record.before, changes: ['start'], owners: {} }
const button = (wrapper, text) => wrapper.findAll('button').find(b => b.text() === text)

describe('操作记录卡片', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    state.list.mockResolvedValue({ records: [{ ...record }], retained_count: 1, has_more: false, next_cursor: null })
    state.annotate.mockResolvedValue({ annotation_version: 4 })
    state.preview.mockResolvedValue(preview)
    state.restore.mockResolvedValue({ success: true })
  })

  it('显示操作人和变化，备注按原记录版本保存，与任务备注分开', async () => {
    const wrapper = mount(TaskHistoryCard)
    await flushPromises()
    expect(wrapper.text()).toContain('每个任务保留最近 50 条')
    expect(wrapper.text()).toContain('用户甲')
    await button(wrapper, '查看详情').trigger('click')
    expect(wrapper.text()).toContain('08:00:00 → 07:30:00')
    await button(wrapper, '添加备注').trigger('click')
    await wrapper.get('textarea').setValue('7:30 前没数据')
    await button(wrapper, '保存备注').trigger('click')
    await flushPromises()
    expect(state.annotate).toHaveBeenCalledWith('10', '7:30 前没数据', 3)
    expect(state.restore).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('先预览覆盖范围，确认后仅提交记录 ID 和当前任务版本；成功后通知页面刷新', async () => {
    const wrapper = mount(TaskHistoryCard)
    await flushPromises()
    await button(wrapper, '还原').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('会覆盖选中记录之后对本任务的修改')
    expect(state.restore).not.toHaveBeenCalled()
    await button(wrapper, '确认还原此任务').trigger('click')
    await flushPromises()
    expect(state.restore).toHaveBeenCalledWith('10', 9)
    expect(wrapper.emitted('restored')).toHaveLength(1)
    wrapper.unmount()
  })

  it('有本地草稿时禁止还原，预览后产生的草稿同样保护', async () => {
    const wrapper = mount(TaskHistoryCard, { props: { isTaskDirty: () => true } })
    await flushPromises()
    expect(button(wrapper, '还原').attributes('disabled')).toBeDefined()
    expect(state.preview).not.toHaveBeenCalled()
    await wrapper.setProps({ isTaskDirty: () => false })
    await button(wrapper, '还原').trigger('click')
    await flushPromises()
    await wrapper.setProps({ isTaskDirty: () => true })
    expect(button(wrapper, '确认还原此任务').attributes('disabled')).toBeDefined()
    expect(state.restore).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('服务器拒绝还原时保留弹窗和错误，不报告成功', async () => {
    state.restore.mockRejectedValue(new Error('任务已被修改'))
    const wrapper = mount(TaskHistoryCard)
    await flushPromises()
    await button(wrapper, '还原').trigger('click')
    await flushPromises()
    await button(wrapper, '确认还原此任务').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="dialog"]').text()).toContain('任务已被修改')
    expect(wrapper.emitted('restored')).toBeUndefined()
    wrapper.unmount()
  })

  it('旧记录只读，展示已还原操作人；加载失败显示错误', async () => {
    state.list.mockResolvedValueOnce({ records: [{ ...record, snapshot_complete: false, can_restore: false, reverted: true, reverted_by_name: '用户乙' }], retained_count: 1 })
    const wrapper = mount(TaskHistoryCard)
    await flushPromises()
    expect(wrapper.text()).toContain('旧记录缺少完整快照')
    expect(wrapper.text()).toContain('已由 用户乙 还原')
    expect(button(wrapper, '还原')).toBeUndefined()
    state.list.mockRejectedValueOnce(new Error('网络错误'))
    await button(wrapper, '刷新记录').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('操作记录加载失败：网络错误')
    wrapper.unmount()
  })

  it('筛选请求变更后忽略旧响应，翻页替换记录而不累计', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 100 })
    let resolveOld
    state.list.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const wrapper = mount(TaskHistoryCard, { props: { users: [{ id: '7', display_name: '用户甲' }] } })
    state.list.mockResolvedValueOnce({ records: Array.from({ length: 6 }, (_, i) => ({ ...record, id: String(10 + i), task_name: i < 2 ? '第一页任务' : '第二页任务' })), retained_count: 6 })
    await wrapper.findAll('select')[0].setValue('7')
    await flushPromises()
    resolveOld({ records: [], retained_count: 0, has_more: false })
    await flushPromises()
    expect(wrapper.get('.history-rows').text()).toContain('第一页任务')
    const calls = state.list.mock.calls.length
    await button(wrapper, '下一页').trigger('click')
    await flushPromises()
    expect(state.list).toHaveBeenLastCalledWith({ actor_id: '7', task_id: null, task_ids: null, page: 1, limit: 50 })
    expect(state.list).toHaveBeenCalledTimes(calls)
    expect(wrapper.get('.history-rows').text()).toContain('第二页任务')
    expect(wrapper.get('.history-rows').text()).not.toContain('第一页任务')
    wrapper.unmount()
  })

  it('跟随主筛选任务集合，空集合直接显示为空，轮询不重置当前页', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 100 })
    state.list.mockResolvedValue({ records: [{ ...record }, { ...record, id: '11', task_name: '第二页任务' }], retained_count: 2 })
    const wrapper = mount(TaskHistoryCard, { props: { visibleTaskIds: '1,2' } })
    await flushPromises()
    expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ task_ids: '1,2', page: 1 }))
    await button(wrapper, '下一页').trigger('click')
    await flushPromises()
    await wrapper.setProps({ refreshKey: 2 })
    await flushPromises()
    expect(wrapper.get('.history-rows').text()).toContain('第二页任务')
    await wrapper.setProps({ visibleTaskIds: '2' })
    await flushPromises()
    expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ task_ids: '2', page: 1 }))
    const calls = state.list.mock.calls.length
    await wrapper.setProps({ visibleTaskIds: '' })
    await flushPromises()
    expect(state.list).toHaveBeenCalledTimes(calls)
    expect(wrapper.text()).toContain('暂无操作记录')
    wrapper.unmount()
  })

  it('旧记录也能点击整行查看完整名称、备注和操作信息，备注按钮不打开详情', async () => {
    const taskName = '非常长的任务名称'.repeat(30)
    const annotation = '完整备注\n'.repeat(80)
    state.list.mockResolvedValueOnce({ records: [{ ...record, task_name: taskName, annotation, snapshot_complete: false, can_restore: false }], retained_count: 1 })
    const wrapper = mount(TaskHistoryCard)
    await flushPromises()
    await button(wrapper, '编辑备注').trigger('click')
    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    await button(wrapper, '取消').trigger('click')
    await wrapper.get('.history-entry').trigger('click')
    const detail = wrapper.get('[role="dialog"]')
    expect(detail.text()).toContain(taskName)
    expect(detail.text()).toContain(annotation.trim())
    expect(detail.text()).toContain('操作时间')
    expect(detail.text()).toContain('旧记录缺少完整快照')
    expect(wrapper.findAll('.history-rows .history-entry')).toHaveLength(1)
    wrapper.unmount()
  })
})
