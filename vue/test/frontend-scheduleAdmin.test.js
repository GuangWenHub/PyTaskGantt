// @vitest-environment jsdom

import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pageState = vi.hoisted(() => ({
  auth: { user: { id: '7', display_name: '管理员', is_admin: true }, uiRefreshSeconds: 60 },
  load: vi.fn(async () => []),
  syncAllTasks: vi.fn(async () => ({})),
  preview: false,
  success: vi.fn(),
  info: vi.fn(),
  addTask: vi.fn(),
  saveTaskMutations: vi.fn(),
  confirm: vi.fn(),
  savedTasks: {},
  rebindTask: vi.fn(),
  recoverTask: vi.fn(async () => ({ success: true })),
  slotStub: { template: '<div><slot /></div>' },
  task: {
    id: '10',
    task: '历史任务',
    start: '09:00:00',
    finish: '10:00:00',
    bot: '旧机器人',
    tags: [],
    note: '',
    version: 3,
    owner: null,
    schedule_uuid: '',
    can_edit: false,
    is_legacy_unbound: true,
    normalized_status: '待运行',
  },
}))

vi.mock('../src/services/authService.js', () => ({ auth: pageState.auth }))
vi.mock('../src/services/taskService.js', () => ({
  exportTasks: vi.fn(),
  saveTaskMutations: pageState.saveTaskMutations,
  getUsers: vi.fn(async () => [{ id: '8', display_name: '目标用户' }]),
  importTasks: vi.fn(),
  rebindTask: pageState.rebindTask,
  recoverTask: pageState.recoverTask,
  runTask: vi.fn(),
  syncTask: vi.fn(),
  syncAllTasks: pageState.syncAllTasks,
  transferTask: vi.fn(),
}))
vi.mock('../src/stores/taskDraftStore.js', () => ({
  myTaskStore: { isDirty: () => false, state: { loaded: false } },
  hasAnyTaskSaveInProgress: () => false,
  scheduleTaskStore: {
    state: { loading: false, saving: false, error: '', savedTasks: pageState.savedTasks },
    tasks: { value: [pageState.task] },
    hasUnsaved: { value: false },
    hasPreviews: { get value() { return pageState.preview } },
    mutationList: { value: [] },
    load: pageState.load,
    save: vi.fn(),
    addTask: pageState.addTask,
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    isDirty: vi.fn(() => false),
  },
}))

vi.mock('../src/components/AppShell.vue', () => ({
  default: { name: 'AppShell', template: '<main><header><slot name="header-meta" /></header><slot /></main>' },
}))
vi.mock('../src/components/ExecutionHistoryDialog.vue', () => ({
  default: { name: 'ExecutionHistoryDialog', template: '<div />' },
}))
vi.mock('../src/components/TaskHistoryCard.vue', () => ({
  default: { name: 'TaskHistoryCard', template: '<div />' },
}))
vi.mock('../src/components/FilterPanel.vue', () => ({
  default: { name: 'FilterPanel', template: '<div />' },
}))
vi.mock('../src/components/GanttChart.vue', () => ({
  default: { name: 'GanttChart', template: '<div />' },
}))
vi.mock('../src/components/TaskEditor.vue', () => ({
  default: { name: 'TaskEditor', props: ['show', 'saving', 'mode', 'task'], template: '<div />' },
}))
vi.mock('../src/components/TaskList.vue', () => ({
  default: {
    name: 'TaskList',
    props: ['tasks', 'canRecover'],
    emits: ['recover'],
    template: '<button v-if="canRecover" class="recover-entry" @click="$emit(\'recover\', tasks[0])">分配并绑定</button>',
  },
}))
vi.mock('../src/components/SchedulePicker.vue', () => ({
  default: {
    name: 'SchedulePicker',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<button class="schedule-choice" @click="$emit(\'update:modelValue\', \'schedule-recovered\')">选择计划</button>',
  },
}))

vi.mock('naive-ui', () => ({
  NAlert: pageState.slotStub,
  NButton: {
    props: ['disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NModal: {
    props: ['show'],
    emits: ['update:show'],
    template: '<section v-if="show"><slot /><slot name="footer" /></section>',
  },
  NSelect: {
    props: ['value'],
    emits: ['update:value'],
    template: '<button class="owner-choice" @click="$emit(\'update:value\', \'8\')">选择用户</button>',
  },
  NSpace: pageState.slotStub,
  NSpin: pageState.slotStub,
  NTag: pageState.slotStub,
  useDialog: () => ({ warning: pageState.confirm }),
  useMessage: () => ({ error: vi.fn(), info: pageState.info, success: pageState.success, warning: vi.fn() }),
}))

import SchedulePage from '../src/pages/SchedulePage.vue'

describe('SchedulePage administrator recovery', () => {
  it('编辑窗口换绑复用现有确认流程，成功后保留编辑框并显示新绑定版本', async () => {
    const original = { ...pageState.task }
    Object.assign(pageState.task, { can_edit: true, schedule_uuid: 'old-plan' })
    const updated = { ...pageState.task, schedule_uuid: 'schedule-recovered', version: 4 }
    pageState.rebindTask.mockResolvedValue({ success: true, task: updated })
    const wrapper = mount(SchedulePage)
    try {
      await flushPromises()
      wrapper.findComponent({ name: 'TaskList' }).vm.$emit('edit', pageState.task)
      await nextTick()
      const editor = wrapper.findComponent({ name: 'TaskEditor' })
      editor.vm.$emit('rebind', editor.props('task'))
      await nextTick()
      await wrapper.get('.schedule-choice').trigger('click')
      await nextTick()
      await wrapper.findAll('button').find(button => button.text() === '确认换绑').trigger('click')
      await flushPromises()
      expect(pageState.rebindTask).toHaveBeenCalledWith('10', 'schedule-recovered', 3)
      expect(editor.props('show')).toBe(true)
      // The stub store still has the old binding: it must not overwrite the new API response.
      expect(editor.props('task')).toMatchObject({ schedule_uuid: 'schedule-recovered', version: 4 })
    } finally { wrapper.unmount(); Object.keys(pageState.task).forEach(key => delete pageState.task[key]); Object.assign(pageState.task, original) }
  })

  it('编辑本地保存只提交当前任务差异与原版本，不夹带其他预览或缓存字段', async () => {
    const original = { ...pageState.task }
    Object.assign(pageState.task, { can_edit: true, schedule_uuid: 'bound-plan', timing_mode: 'single', expected_duration_seconds: 60, schedule_dispatch: {}, schedule_cron_expression: '' })
    const wrapper = mount(SchedulePage)
    try {
      await flushPromises()
      wrapper.findComponent({ name: 'TaskList' }).vm.$emit('edit', pageState.task)
      await nextTick()
      const editor = wrapper.findComponent({ name: 'TaskEditor' })
      pageState.saveTaskMutations.mockResolvedValue({ tasks: [], id_map: {} })
      editor.vm.$emit('save-local', { ...pageState.task, task: '保存后的名称', note: '本地备注', _local_preview_fields: { cron: false, dispatch: false } })
      await flushPromises()
      expect(pageState.saveTaskMutations).toHaveBeenCalledWith([{ type: 'update', id: '10', version: 3, changes: { task: '保存后的名称', note: '本地备注' } }])
      expect(editor.props('show')).toBe(false)
      expect(pageState.success).toHaveBeenCalledWith('任务已保存到本地数据库，刷新后仍会保留')
      expect(pageState.info).not.toHaveBeenCalled()
    } finally { wrapper.unmount(); Object.keys(pageState.task).forEach(key => delete pageState.task[key]); Object.assign(pageState.task, original) }
  })
  it('编辑的循环规则或多机策略仅支持预览时拒绝部分保存，保持弹窗', async () => {
    const original = { ...pageState.task }
    Object.assign(pageState.task, { can_edit: true, schedule_uuid: 'bound-plan', schedule_cron_expression: '*/10 * * * *', schedule_dispatch: { execute_scope: 'any', clients: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } })
    const wrapper = mount(SchedulePage)
    try {
      await flushPromises()
      wrapper.findComponent({ name: 'TaskList' }).vm.$emit('edit', pageState.task)
      await nextTick()
      const editor = wrapper.findComponent({ name: 'TaskEditor' })
      editor.vm.$emit('save-local', { ...pageState.task, task: '名称', schedule_cron_expression: '*/5 * * * *', _local_preview_fields: { cron: true } })
      await flushPromises()
      expect(pageState.saveTaskMutations).not.toHaveBeenCalled()
      expect(editor.props('show')).toBe(true)
      editor.vm.$emit('save-local', { ...pageState.task, task: '名称', schedule_dispatch: { clients: [{ id: 'a', name: 'A' }] }, _local_preview_fields: { dispatch: true } })
      await flushPromises()
      expect(pageState.saveTaskMutations).not.toHaveBeenCalled()
      expect(editor.props('show')).toBe(true)
    } finally { wrapper.unmount(); Object.keys(pageState.task).forEach(key => delete pageState.task[key]); Object.assign(pageState.task, original) }
  })

  it('未绑定新增仅加入预览；保存本地必须带绑定且只提交单条新增，不保存其他草稿', async () => {
    const wrapper = mount(SchedulePage)
    await flushPromises()
    wrapper.findComponent({ name: 'FilterPanel' }).vm.$emit('create')
    await nextTick()
    const form = { task: '手工任务', start: '23:50:00', finish: '00:20:00', bot: 'A', tags: ['测试'], note: '', timing_mode: 'single', expected_duration_seconds: 1800, schedule_uuid: '' }
    const editor = wrapper.findComponent({ name: 'TaskEditor' })
    editor.vm.$emit('save-local', form)
    await flushPromises()
    expect(pageState.saveTaskMutations).not.toHaveBeenCalled()
    editor.vm.$emit('submit', form)
    await flushPromises()
    expect(pageState.addTask).toHaveBeenCalledWith(form)
    expect(pageState.saveTaskMutations).not.toHaveBeenCalled()
    wrapper.findComponent({ name: 'FilterPanel' }).vm.$emit('create')
    await nextTick()
    pageState.info.mockClear()
    pageState.saveTaskMutations.mockResolvedValue({ id_map: { local: '123' } })
    editor.vm.$emit('save-local', { ...form, schedule_uuid: 'valid-plan', schedule_dispatch: { clients: [] }, schedule_cron_expression: 'client-cache' })
    await flushPromises()
    const mutations = pageState.saveTaskMutations.mock.calls[0][0]
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ type: 'create', schedule_uuid: 'valid-plan', task: '手工任务' })
    expect(mutations[0]).not.toHaveProperty('schedule_dispatch')
    expect(mutations[0]).not.toHaveProperty('schedule_cron_expression')
    expect(pageState.success).toHaveBeenCalledWith('任务已保存到本地数据库，刷新后仍会保留')
    expect(pageState.info).not.toHaveBeenCalled()
    expect(editor.props('show')).toBe(false)
    wrapper.unmount()
  })
  it('保存过程中防止重复提交，失败保留弹窗和输入', async () => {
    const wrapper = mount(SchedulePage)
    await flushPromises()
    wrapper.findComponent({ name: 'FilterPanel' }).vm.$emit('create')
    await nextTick()
    let reject
    pageState.saveTaskMutations.mockReturnValue(new Promise((_, fail) => { reject = fail }))
    const editor = wrapper.findComponent({ name: 'TaskEditor' })
    const form = { task: '新任务', schedule_uuid: 'valid-plan' }
    editor.vm.$emit('save-local', form)
    editor.vm.$emit('save-local', form)
    await nextTick()
    expect(pageState.saveTaskMutations).toHaveBeenCalledTimes(1)
    expect(editor.props('saving')).toBe(true)
    reject(new Error('绑定已占用'))
    await flushPromises()
    expect(editor.props('show')).toBe(true)
    expect(editor.props('saving')).toBe(false)
    wrapper.unmount()
  })

  beforeEach(() => {
    pageState.syncAllTasks.mockClear()
    pageState.auth.user.is_admin = true
    pageState.rebindTask.mockReset()
    pageState.recoverTask.mockClear()
    pageState.load.mockClear()
    pageState.preview = false
    pageState.success.mockClear()
    pageState.info.mockClear()
    pageState.addTask.mockClear()
    pageState.saveTaskMutations.mockReset()
  })

  it('人工处置复用任务编辑，删除在确认后按当前绑定版本写入本地', async () => {
    const task = { ...pageState.task, schedule_uuid: 'old-plan', can_edit: true, is_legacy_unbound: false }
    const row = { task_id: task.id, schedule_uuid: task.schedule_uuid, can_apply: false, kind: 'error' }
    pageState.savedTasks[task.id] = task
    pageState.confirm.mockClear()
    pageState.saveTaskMutations.mockResolvedValue({})
    const wrapper = mount(SchedulePage)
    try {
      await flushPromises()
      const sync = wrapper.findComponent({ name: 'ScheduleReconciliationDialog' })
      const editor = wrapper.findComponent({ name: 'TaskEditor' })
      sync.vm.$emit('edit-local', row)
      await nextTick()
      expect(editor.props('show')).toBe(true)
      expect(editor.props('task').schedule_uuid).toBe(task.schedule_uuid)
      editor.vm.$emit('update:show', false)
      await nextTick()
      expect(sync.props('show')).toBe(true)
      sync.vm.$emit('delete-local', { ...row, schedule_uuid: 'obsolete' })
      expect(pageState.confirm).not.toHaveBeenCalled()
      sync.vm.$emit('delete-local', row)
      expect(pageState.saveTaskMutations).not.toHaveBeenCalled()
      await pageState.confirm.mock.lastCall[0].onPositiveClick()
      expect(pageState.saveTaskMutations).toHaveBeenCalledWith([{ type: 'delete', id: task.id, version: task.version }])
      expect(pageState.load).toHaveBeenLastCalledWith({ preserveDraft: true, silent: false })
    } finally {
      delete pageState.savedTasks[task.id]
      wrapper.unmount()
    }
  })

  it('打开页面和点击刷新均同步影刀，重复点击共用进行中的刷新', async () => {
    const wrapper = mount(SchedulePage)
    await flushPromises()
    expect(pageState.syncAllTasks).toHaveBeenCalledTimes(1)
    let complete
    pageState.syncAllTasks.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const filters = wrapper.findComponent({ name: 'FilterPanel' })
    filters.vm.$emit('refresh')
    filters.vm.$emit('refresh')
    expect(pageState.syncAllTasks).toHaveBeenCalledTimes(2)
    complete()
    await flushPromises()
    expect(pageState.load).toHaveBeenLastCalledWith({ preserveDraft: false })
    expect(pageState.success).toHaveBeenCalledWith('影刀数据已同步并刷新')
    wrapper.unmount()
  })

  it('管理员看到恢复入口并提交目标用户、计划和乐观锁版本', async () => {
    const wrapper = mount(SchedulePage)
    await flushPromises()
    expect(wrapper.text()).not.toContain('全员任务沙盘')
    expect(wrapper.text()).not.toContain('所有登录用户均可查看')
    expect(wrapper.get('header .header-run-status').text()).toBe('暂无有效计划配置缓存')
    expect(wrapper.text()).not.toContain('影刀数据截至')
    expect(wrapper.findComponent({ name: 'TaskList' }).props('canRecover')).toBe(true)

    await wrapper.get('.recover-entry').trigger('click')
    await wrapper.get('.owner-choice').trigger('click')
    await wrapper.get('.schedule-choice').trigger('click')
    await nextTick()
    const confirm = wrapper.findAll('button').find(button => button.text() === '确认分配并绑定')
    expect(confirm.attributes('disabled')).toBeUndefined()
    await confirm.trigger('click')
    await flushPromises()

    expect(pageState.recoverTask).toHaveBeenCalledWith('10', '8', 'schedule-recovered', 3)
    expect(pageState.load).toHaveBeenLastCalledWith({ preserveDraft: true, silent: true })
    wrapper.unmount()
  })

  it('普通用户不显示历史任务恢复入口', async () => {
    pageState.auth.user.is_admin = false
    const wrapper = mount(SchedulePage)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'TaskList' }).props('canRecover')).toBe(false)
    expect(wrapper.find('.recover-entry').exists()).toBe(false)
    wrapper.unmount()
  })

  it('仅有预览或表单调整时阻止直接刷新，卸载后移除刷新监听', async () => {
    const wrapper = mount(SchedulePage)
    await flushPromises()
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    pageState.preview = true
    const preview = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(preview)
    expect(preview.defaultPrevented).toBe(true)
    pageState.preview = false
    wrapper.findComponent({ name: 'TaskEditor' }).vm.$emit('preview-change')
    const editing = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(editing)
    expect(editing.defaultPrevented).toBe(true)
    wrapper.unmount()
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})
