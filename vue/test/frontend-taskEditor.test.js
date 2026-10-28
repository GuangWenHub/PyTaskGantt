// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/yingdaoService.js', () => ({
  getScheduleCron: vi.fn(async () => ({ expression: '0 0-8/2 * * *', stale: false })),
  getScheduleDispatch: vi.fn(async () => ({ dispatch: { clients: [] }, stale: false })),
  getSchedules: vi.fn(async () => ({ schedules: [{ schedule_uuid: 'schedule-1', schedule_name: '影刀计划名称' }] })),
}))
vi.mock('naive-ui', () => {
  const slot = { template: '<div><slot /></div>' }
  const field = { props: ['label'], template: '<div><label>{{ label }}</label><slot /></div>' }
  return {
    NModal: { template: '<section><slot /><slot name="footer" /></section>' },
    NForm: { setup(_, { expose }) { expose({ validate: async () => {} }) }, template: '<form><slot /></form>' },
    NFormItem: field, NFormItemGi: field, NGrid: slot,
    NButton: { template: '<button type="button"><slot /></button>' },
    NSpace: slot, NAlert: slot, NInput: { name: 'NInput', props: ['value', 'readonly'], template: '<input :value="value" :readonly="readonly" />' },
    NInputNumber: { name: 'NInputNumber', props: ['value'], emits: ['update:value'], template: '<input :value="value" />' },
    NSelect: { name: 'NSelect', props: { value: Array, options: Array, multiple: Boolean, disabled: Boolean }, template: '<div />' },
    NTimePicker: slot, NEmpty: slot, NInputGroup: slot, NPagination: slot, NSpin: slot, NTag: slot,
    useMessage: () => ({ warning: vi.fn() }), useDialog: () => ({ warning: vi.fn() }),
  }
})
import TaskEditor from '../src/components/TaskEditor.vue'
import { getScheduleCron, getScheduleDispatch } from '../src/services/yingdaoService.js'

function editor(mode, task = {}) {
  return mount(TaskEditor, {
    props: { show: true, mode, task },
    global: { stubs: { SchedulePicker: true } },
  })
}

describe('任务类型卡片', () => {
  it('计划名与UUID并列；候选机器合并进多选框，全部时刻可查看且规则只读', async () => {
    getScheduleCron.mockResolvedValueOnce({ expression: '*/10 * * * *', stale: false })
    getScheduleDispatch.mockResolvedValueOnce({ dispatch: { execute_scope: 'any', clients: [{ id: 'a', name: 'admin@tenant' }, { id: 'b', name: 'bot_1@tenant' }] }, stale: false })
    const wrapper = editor('edit', { id: '1', task: '循环任务', bot: '旧Bot', timing_mode: 'cron', schedule_uuid: 'schedule-1' })
    await flushPromises()
    expect(wrapper.get('.binding-identity').text()).toContain('schedule-1')
    expect(wrapper.get('.binding-identity').text()).toContain('影刀计划名称')
    expect(wrapper.find('.dispatch-preview').exists()).toBe(false)
    const select = wrapper.findComponent({ name: 'NSelect' })
    expect(select.props()).toMatchObject({ value: ['a', 'b'], multiple: true, disabled: true })
    expect(wrapper.text()).toContain('机器人 / Bot（共享 · 任选1台）')
    expect(wrapper.get('.cron-times').findAll('span')).toHaveLength(144)
    expect(wrapper.get('.cron-times').text()).toContain('23:50')
    expect(wrapper.get('input[aria-label="影刀循环规则"]').attributes()).toHaveProperty('readonly')
    await wrapper.findAll('button').find(button => button.text() === '保存到草稿').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('submit')[0][0].bot).toBe('旧Bot')
    wrapper.unmount()
  })
  it('新增窗口可切换类型，并保留常规标签与时间', async () => {
    const wrapper = editor('create', { task: '测试任务', bot: 'A', start: '23:30:00', finish: '01:00:00', tags: ['每日'], schedule_uuid: 'schedule-1' })
    expect(wrapper.text()).toContain('标签')
    await wrapper.get('.task-type-card:nth-child(2)').trigger('click')
    await flushPromises()
    expect(wrapper.get('.task-type-card:nth-child(2)').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[aria-label="常规任务设置"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="循环任务设置"]').text()).toContain('🔁 循环任务')
    expect(wrapper.text()).not.toContain('开始时间 *')
    expect(wrapper.findComponent({ name: 'NSelect' }).exists()).toBe(true) // Bot selector remains shared.
    await wrapper.get('.task-type-card:first-child').trigger('click')
    expect(wrapper.find('[aria-label="循环任务设置"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="常规任务设置"]').text()).toContain('标签')
    await wrapper.findAll('button').find(button => button.text().includes('草稿')).trigger('click')
    await flushPromises()
    expect(wrapper.emitted('submit')[0][0]).toMatchObject({ timing_mode: 'single', tags: ['每日'], start: '23:30:00', finish: '01:00:00' })
    wrapper.unmount()
  })

  it('编辑常规任务直接展示原表单，不提供类型切换', async () => {
    const wrapper = editor('edit', { id: '2', task: '常规任务', bot: 'A', timing_mode: 'single', tags: ['每周'], start: '23:30:00', finish: '01:00:00' })
    expect(wrapper.find('.task-type-cards').exists()).toBe(false)
    expect(wrapper.find('.task-folder-content').exists()).toBe(false)
    expect(wrapper.get('[aria-label="常规任务设置"]').text()).toContain('标签')
    expect(wrapper.find('[aria-label="循环任务设置"]').exists()).toBe(false)
    await wrapper.findAll('button').find(button => button.text() === '保存到草稿').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('submit')[0][0]).toMatchObject({ timing_mode: 'single', tags: ['每周'], start: '23:30:00', finish: '01:00:00' })
    wrapper.unmount()
  })

  it('编辑循环任务直接显示对应表单，无页签或标签选择', async () => {
    const wrapper = editor('edit', { id: '1', task: '循环任务', bot: 'A', timing_mode: 'cron', expected_duration_seconds: 60, tags: ['每日'], schedule_uuid: 'schedule-1', schedule_cron_expression: '0 0-8/2 * * *' })
    await flushPromises()
    expect(wrapper.find('.task-type-cards').exists()).toBe(false)
    expect(wrapper.find('.task-folder-content').exists()).toBe(false)
    expect(wrapper.find('[aria-label="常规任务设置"]').exists()).toBe(false)
    const duration = wrapper.findComponent({ name: 'NInputNumber' })
    duration.vm.$emit('update:value', 120)
    await wrapper.findAll('button').find(button => button.text() === '保存到草稿').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('submit')[0][0]).toMatchObject({ timing_mode: 'cron', expected_duration_seconds: 120, tags: ['每日'] })
    wrapper.unmount()
  })
})
