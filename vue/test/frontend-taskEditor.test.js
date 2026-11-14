// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hideState = vi.hoisted(() => ({ confirm: null, success: vi.fn(), error: vi.fn(), info: vi.fn(), destroyNotice: vi.fn() }))
vi.mock('../src/services/taskService.js', () => ({ setTaskVisibility: vi.fn() }))
vi.mock('../src/services/yingdaoService.js', () => ({
  getScheduleEditor: vi.fn(),
  getScheduleRecentRuns: vi.fn(),
}))
vi.mock('naive-ui', () => {
  const slot = { template: '<div><slot /></div>' }
  const field = { props: ['label'], template: '<div><label>{{ label }}</label><slot /></div>' }
  return {
    NModal: { template: '<section><slot /><slot name="footer" /></section>' },
    NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
    NForm: { setup(_, { expose }) { expose({ validate: async () => {} }) }, template: '<form><slot /></form>' },
    NFormItem: field, NFormItemGi: field, NGrid: slot,
    NButton: { template: '<button type="button"><slot /></button>' },
    NSpace: slot, NAlert: slot, NInput: { name: 'NInput', props: ['value', 'readonly'], emits: ['update:value'], template: '<input :value="value" :readonly="readonly" />' },
    NInputNumber: { name: 'NInputNumber', props: ['value'], emits: ['update:value'], template: '<input :value="value" />' },
    NSelect: { name: 'NSelect', props: { value: Array, options: Array, multiple: Boolean, disabled: Boolean }, template: '<div />' },
    NTimePicker: { name: 'NTimePicker', props: { formattedValue: String, disabled: Boolean }, template: '<div />' }, NEmpty: slot, NInputGroup: slot, NPagination: slot, NSpin: slot, NTag: slot,
    useMessage: () => ({ warning: vi.fn(), success: hideState.success, error: hideState.error, info: hideState.info }), useDialog: () => ({ warning: options => { hideState.confirm = options } }),
  }
})
import TaskEditor from '../src/components/TaskEditor.vue'
import { setTaskVisibility } from '../src/services/taskService.js'
import { getScheduleEditor, getScheduleRecentRuns } from '../src/services/yingdaoService.js'

function editor(mode, task = {}) {
  return mount(TaskEditor, {
    props: { show: true, mode, task, allowLocalSave: true },
    global: { stubs: {
      SchedulePicker: true,
      ClockTimePicker: { name: 'ClockTimePicker', props: { value: String, disabled: Boolean, label: String }, emits: ['update:value'], template: '<div />' },
      DurationPicker: { name: 'DurationPicker', props: { value: Number, disabled: Boolean }, emits: ['update:value'], template: '<div />' },
    } },
  })
}

function plan(uuid = 'schedule-1', defaults = {}) {
  return { schedule_uuid: uuid, schedule_name: '影刀计划名称', dispatch: { execute_scope: 'any', clients: [{ id: 'a', name: 'admin@tenant' }, { id: 'b', name: 'bot@tenant' }] }, defaults: { timing_mode: 'single', start: '23:59:00', tags: ['每日'], expression: '', ...defaults } }
}
const recent = { records: [{ task_uuid: 'run-1', status: 'finish', status_name: '成功', start_time: '2026-11-04 23:00:00', end_time: '2026-11-04 23:02:01', duration_seconds: 121 }], sample_count: 2, average_duration_seconds: 61, max_duration_seconds: 121, min_duration_seconds: 1, rounded_duration_seconds: 180 }
async function submit(wrapper) {
  await wrapper.findAll('button').find(button => /应用到预览|保存到草稿|加入待保存草稿|保存到本地/.test(button.text())).trigger('click')
  await flushPromises()
  return wrapper.emitted('submit')?.[0]?.[0] || wrapper.emitted('save-local')?.[0]?.[0]
}

describe('影刀计划自动填写', () => {
  it.each(['create', 'edit'])('新增/编辑保存文案明确刷新保留，并在保存前清除旧的编辑提示：%s', async mode => {
    const wrapper = editor(mode, { id: mode === 'edit' ? '1' : undefined, schedule_uuid: 'schedule-1', task: '任务', bot: 'A' })
    await wrapper.setProps({ previewOnly: true })
    await flushPromises()
    await wrapper.get('form').trigger('input')
    expect(hideState.info.mock.calls[0][0]).toContain('保存后刷新仍会保留')
    expect(hideState.info.mock.calls[0][0]).not.toContain('会消失')
    await wrapper.findAll('button').find(button => button.text() === '保存到本地').trigger('click')
    expect(hideState.destroyNotice).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('save-local')).toHaveLength(1)
    expect(wrapper.emitted('submit')).toBeUndefined()
    wrapper.unmount()
  })

  it('编辑已有绑定任务不显示顶部提示，并可独立保存本地而不提交预览', async () => {
    const wrapper = editor('edit', { id: '1', version: 3, schedule_uuid: 'schedule-1', task: '任务', bot: 'A' })
    await wrapper.setProps({ previewOnly: true })
    await flushPromises()
    expect(wrapper.text()).not.toContain('当前修改仅影响本地预览，刷新后改动会消失。')
    const save = wrapper.findAll('button').find(button => button.text() === '保存到本地')
    expect(save).toBeTruthy()
    await save.trigger('click')
    expect(wrapper.emitted('save-local')[0][0]).toMatchObject({ id: '1', version: 3, schedule_uuid: 'schedule-1' })
    expect(wrapper.emitted('submit')).toBeUndefined()
    await wrapper.setProps({ task: { id: 'tmp:preview', schedule_uuid: 'schedule-1' } })
    await flushPromises()
    expect(wrapper.findAll('button').some(button => button.text() === '保存到本地')).toBe(false)
    wrapper.unmount()
  })

  it('不绑定计划也可预览并手动选机器，只有绑定后才出现独立保存到本地按钮', async () => {
    const wrapper = editor('create', { task: '临时预览', bot: '手动机器', start: '23:50:00', finish: '00:20:00' })
    await wrapper.setProps({ previewOnly: true })
    await flushPromises()
    expect(wrapper.findAll('button').some(button => button.text() === '保存到本地')).toBe(false)
    expect(wrapper.findAllComponents({ name: 'NSelect' })[0].props('disabled')).toBe(false)
    const preview = await submit(wrapper)
    expect(preview).toMatchObject({ task: '临时预览', schedule_uuid: '', start: '23:50:00', finish: '00:20:00' })
    expect(wrapper.emitted('save-local')).toBeUndefined()
    const picker = wrapper.findComponent({ name: 'SchedulePicker' })
    picker.vm.$emit('update:modelValue', 'schedule-1')
    picker.vm.$emit('select', { schedule_uuid: 'schedule-1', schedule_name: '影刀计划名称' })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '保存到本地').trigger('click')
    expect(wrapper.emitted('save-local')[0][0]).toMatchObject({ schedule_uuid: 'schedule-1', task: '影刀计划名称' })
    expect(wrapper.emitted('submit')).toHaveLength(1)
    picker.vm.$emit('update:modelValue', '')
    await flushPromises()
    expect(wrapper.findAll('button').some(button => button.text() === '保存到本地')).toBe(false)
    wrapper.unmount()
  })

  it('仅持久任务编辑时提供灰色隐藏入口，确认提示包含设置恢复；确认前不写入', async () => {
    const wrapper = editor('edit', { id: '1', task: '要隐藏的任务' })
    await flushPromises()
    await wrapper.get('.hide-task-link').trigger('click')
    expect(hideState.confirm.content).toContain('设置')
    expect(hideState.confirm.content).toContain('恢复显示')
    expect(hideState.confirm.content).toContain('不会保存')
    expect(setTaskVisibility).not.toHaveBeenCalled()
    setTaskVisibility.mockResolvedValue({ tasks: [] })
    await hideState.confirm.onPositiveClick()
    expect(setTaskVisibility).toHaveBeenCalledWith([{ id: '1', expected_hidden: false, is_hidden: true }])
    expect(wrapper.emitted('hidden')).toEqual([['1']])
    expect(wrapper.emitted('update:show')).toEqual([[false]])
    wrapper.unmount()
    const create = editor('create')
    expect(create.find('.hide-task-link').exists()).toBe(false)
    create.unmount()
    const temporary = editor('edit', { id: 'tmp:1' })
    expect(temporary.find('.hide-task-link').exists()).toBe(false)
    temporary.unmount()
  })
  it('隐藏保存失败时保留编辑弹窗，已隐藏任务不能再次提交', async () => {
    const wrapper = editor('edit', { id: '1', task: '任务' })
    await flushPromises()
    await wrapper.get('.hide-task-link').trigger('click')
    setTaskVisibility.mockRejectedValue(new Error('隐藏名单已变化'))
    expect(await hideState.confirm.onPositiveClick()).toBe(false)
    expect(hideState.error).toHaveBeenCalledWith('隐藏名单已变化')
    expect(wrapper.emitted('hidden')).toBeUndefined()
    expect(wrapper.emitted('update:show')).toBeUndefined()
    await wrapper.setProps({ task: { id: '1', task: '任务', is_hidden: true } })
    expect(wrapper.get('.hide-task-link').text()).toBe('已隐藏')
    expect(wrapper.get('.hide-task-link').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('差异新增没有有效历史耗时必须人工确认，不会静默使用默认一分钟', async () => {
    getScheduleRecentRuns.mockResolvedValue({ records: [], rounded_duration_seconds: null })
    const wrapper = editor('create', { schedule_uuid: 'schedule-1' })
    await wrapper.setProps({ persisting: true })
    await flushPromises()
    expect(wrapper.text()).toContain('没有可用的历史耗时')
    expect(await submit(wrapper)).toBeUndefined()
    wrapper.findComponent({ name: 'DurationPicker' }).vm.$emit('update:value', 600)
    await flushPromises()
    expect(await submit(wrapper)).toMatchObject({ expected_duration_seconds: 600, finish: '00:09:00' })
    wrapper.unmount()
  })
  it('编辑保留本地已保存的时间，远端详情迟到也不能覆盖；只改名称不附带时间变化', async () => {
    const wrapper = editor('edit', { id: '1', schedule_uuid: 'schedule-1', task: '本地任务', bot: 'A', start: '09:00:00', finish: '09:30:00' })
    await wrapper.setProps({ previewOnly: true })
    await flushPromises()
    const clocks = wrapper.findAllComponents({ name: 'ClockTimePicker' })
    expect(clocks[0].props('value')).toBe('09:00:00')
    expect(clocks[1].props('value')).toBe('09:30:00')
    expect(wrapper.findComponent({ name: 'DurationPicker' }).props('value')).toBe(1800)
    expect(await submit(wrapper)).toMatchObject({ start: '09:00:00', finish: '09:30:00' })
    wrapper.unmount()
  })
  it('耗时调整联动结束时间并跨天，手动修改结束时间会回显耗时', async () => {
    const wrapper = editor('edit', { id: '1', schedule_uuid: 'schedule-1', task: '任务', bot: 'A', start: '23:59:00', finish: '00:01:00' })
    await wrapper.setProps({ previewOnly: true })
    await flushPromises()
    const duration = wrapper.findComponent({ name: 'DurationPicker' })
    duration.vm.$emit('update:value', 125)
    await flushPromises()
    expect(wrapper.findAllComponents({ name: 'ClockTimePicker' })[1].props('value')).toBe('00:01:05')
    wrapper.findAllComponents({ name: 'ClockTimePicker' })[1].vm.$emit('update:value', '00:10:00')
    await flushPromises()
    expect(duration.props('value')).toBe(660)
    expect(await submit(wrapper)).toMatchObject({ finish: '00:10:00', expected_duration_seconds: 660 })
    wrapper.unmount()
  })

  it('新增用户已调整耗时时，较晚的运行统计不会重置耗时和结束时间', async () => {
    let resolve
    getScheduleRecentRuns.mockReturnValue(new Promise(r => { resolve = r }))
    const wrapper = editor('create', { schedule_uuid: 'schedule-1' })
    await flushPromises()
    wrapper.findComponent({ name: 'DurationPicker' }).vm.$emit('update:value', 90)
    resolve(recent)
    await flushPromises()
    expect(await submit(wrapper)).toMatchObject({ expected_duration_seconds: 90, finish: '00:00:30' })
    wrapper.unmount()
  })
  it('编辑预览可调整开始时间和多台机器，应用只产生预览载荷', async () => {
    const wrapper = editor('edit', { id: '1', schedule_uuid: 'schedule-1', task: '任务', bot: '原Bot' })
    await wrapper.setProps({ previewOnly: true })
    await flushPromises()
    const machines = wrapper.findComponent({ name: 'NSelect' })
    expect(machines.props('disabled')).toBe(false)
    machines.vm.$emit('update:value', ['a', '人工机器'])
    const start = wrapper.findComponent({ name: 'ClockTimePicker' })
    expect(start.props('disabled')).toBe(false)
    start.vm.$emit('update:value', '08:00:00')
    const payload = await submit(wrapper)
    expect(payload.start).toBe('08:00:00')
    expect(payload.schedule_dispatch.clients).toEqual([{ id: 'a', name: 'admin@tenant' }, { id: 'preview:人工机器', name: '人工机器' }])
    expect(wrapper.emitted('preview-change')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('当前修改仅影响本地预览，刷新后改动会消失。')
    wrapper.unmount()
  })
  beforeEach(() => {
    vi.resetAllMocks()
    hideState.confirm = null
    hideState.info.mockReturnValue({ destroy: hideState.destroyNotice })
    getScheduleEditor.mockImplementation(async uuid => plan(uuid))
    getScheduleRecentRuns.mockResolvedValue(recent)
  })
  it('按最大耗时而非平均值填写默认时长，显示时分秒及跨天预计耗时', async () => {
    const wrapper = editor('create', { schedule_uuid: 'schedule-1' })
    await flushPromises()
    expect(wrapper.find('.task-type-cards').exists()).toBe(false)
    expect(wrapper.findAll('button').some(button => button.text() === '循环任务')).toBe(false)
    expect(wrapper.text()).toContain('常规任务（自动识别）')
    expect(wrapper.text()).toContain('最近10次运行')
    expect(wrapper.text()).toContain('最大运行时间 00:02:01')
    expect(wrapper.text()).toContain('最小运行时间 00:00:01')
    expect(wrapper.text()).toContain('平均耗时 00:01:01')
    expect(wrapper.findComponent({ name: 'DurationPicker' }).props('value')).toBe(180)
    expect(wrapper.get('.task-time-duration').text()).toContain('耗时')
    expect(wrapper.text()).not.toContain('预计耗时')
    expect(wrapper.text()).not.toContain('（时:分:秒）')
    expect(wrapper.text()).not.toContain('建议')
    expect(wrapper.findComponent({ name: 'NSelect' }).props('disabled')).toBe(true)
    expect(wrapper.findComponent({ name: 'ClockTimePicker' }).props('disabled')).toBe(false)
    expect(await submit(wrapper)).toMatchObject({ task: '影刀计划名称', bot: 'admin', tags: ['每日'], start: '23:59:00', finish: '00:02:00', expected_duration_seconds: 180, timing_mode: 'single' })
    wrapper.unmount()
  })
  it('自动识别循环任务，保留周期标签编辑及全部触发时刻', async () => {
    getScheduleEditor.mockResolvedValue(plan('schedule-1', { timing_mode: 'cron', start: '00:00:00', expression: '0 0-8/2 * * *' }))
    const wrapper = editor('create', { schedule_uuid: 'schedule-1' })
    await flushPromises()
    expect(wrapper.find('.task-type-cards').exists()).toBe(false)
    expect(wrapper.get('.cron-times').findAll('span')).toHaveLength(5)
    const tags = wrapper.findAllComponents({ name: 'NSelect' })[1]
    tags.vm.$emit('update:value', ['每周', '人工分类'])
    const name = wrapper.findAllComponents({ name: 'NInput' })[0]
    name.vm.$emit('update:value', '人工任务名称')
    expect(await submit(wrapper)).toMatchObject({ task: '人工任务名称', timing_mode: 'cron', tags: ['每周', '人工分类'] })
    wrapper.unmount()
  })
  it('编辑读取最新类型但保留人工名称、标签、结束时间和预计时长', async () => {
    const wrapper = editor('edit', { id: '1', schedule_uuid: 'schedule-1', task: '人工名称', tags: ['人工标签'], finish: '02:00:00', expected_duration_seconds: 180, bot: '原Bot' })
    await wrapper.setProps({ previewOnly: true })
    await flushPromises()
    expect(wrapper.text()).toContain('应用到预览')
    expect(wrapper.get('.binding-identity').text()).toContain('影刀计划名称')
    expect(await submit(wrapper)).toMatchObject({ task: '人工名称', tags: ['人工标签'], finish: '02:00:00', expected_duration_seconds: 180, bot: '原Bot' })
    wrapper.unmount()
  })
  it('较慢的历史响应不覆盖用户已修改的结束时间', async () => {
    let resolve
    getScheduleRecentRuns.mockReturnValue(new Promise(r => { resolve = r }))
    const wrapper = editor('create', { schedule_uuid: 'schedule-1' })
    await flushPromises()
    wrapper.findAllComponents({ name: 'ClockTimePicker' })[1].vm.$emit('update:value', '05:00:00')
    resolve(recent)
    await flushPromises()
    expect(await submit(wrapper)).toMatchObject({ finish: '05:00:00' })
    wrapper.unmount()
  })
  it('快速换计划时丢弃旧计划的异步响应，名称仍可人工修改', async () => {
    let resolveOld
    getScheduleEditor.mockImplementationOnce(() => new Promise(r => { resolveOld = r }))
    const wrapper = editor('create', { schedule_uuid: 'schedule-1' })
    const picker = wrapper.findComponent({ name: 'SchedulePicker' })
    picker.vm.$emit('update:modelValue', 'schedule-2')
    picker.vm.$emit('select', { schedule_uuid: 'schedule-2', schedule_name: '新计划' })
    await flushPromises()
    resolveOld(plan('schedule-1', { timing_mode: 'cron', expression: '*/5 * * * *' }))
    await flushPromises()
    expect((await submit(wrapper)).schedule_uuid).toBe('schedule-2')
    expect(wrapper.find('[aria-label="循环任务设置"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('历史读取失败不阻止有效计划填写，无历史时不捏造平均耗时', async () => {
    getScheduleRecentRuns.mockRejectedValue(new Error('暂时不可用'))
    const wrapper = editor('create', { schedule_uuid: 'schedule-1' })
    await flushPromises()
    expect(wrapper.text()).toContain('运行记录读取失败')
    expect(wrapper.text()).toContain('暂无可用耗时统计')
    expect(await submit(wrapper)).toBeTruthy()
    wrapper.unmount()
  })
  it('部分运行核验失败显示警告，不使用部分样本自动填写耗时', async () => {
    getScheduleRecentRuns.mockResolvedValue({ ...recent, verification_failed_count: 1, incomplete: true, rounded_duration_seconds: null })
    const wrapper = editor('create', { schedule_uuid: 'schedule-1', start: '09:00:00', finish: '09:30:00', expected_duration_seconds: 1800 })
    await wrapper.setProps({ persisting: true })
    await flushPromises()
    expect(wrapper.text()).toContain('1 条运行记录核验失败')
    expect(wrapper.findComponent({ name: 'DurationPicker' }).props('value')).not.toBe(180)
    expect(await submit(wrapper)).toBeUndefined()
    wrapper.findComponent({ name: 'DurationPicker' }).vm.$emit('update:value', 600)
    await flushPromises()
    expect(await submit(wrapper)).toMatchObject({ expected_duration_seconds: 600 })
    wrapper.unmount()
  })
})
