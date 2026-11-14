// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('naive-ui', () => {
  const slot = { template: '<div><slot /></div>' }
  return { NModal: { props: ['show'], template: '<div v-if="show"><slot /><slot name="footer" /></div>' },
    NButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
    NInput: { props: ['value'], emits: ['update:value'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' },
    NCheckbox: { props: ['checked'], emits: ['update:checked'], template: '<input type="checkbox" :checked="checked" @change="$emit(\'update:checked\', $event.target.checked)" />' },
    NSwitch: { props: ['value'], emits: ['update:value'], template: '<button role="switch" :aria-checked="value" @click="$emit(\'update:value\', !value)" />' },
    NCard: slot, NDropdown: slot, NButtonGroup: slot, NRadioGroup: slot, NRadioButton: slot, NSelect: slot, NEmpty: slot }
})
import HiddenTasksDialog from '../src/components/HiddenTasksDialog.vue'
import { filterTasks } from '../src/services/dataService.js'
import { projectSharedTasks } from '../shared/scheduleDispatch.mjs'
import { useTimelineNamePreference, useTimelineAutoScrollPreference } from '../src/services/timelineNamePreference.js'
import { useCurrentTimeLinePreference, useReferenceLinesPreference } from '../src/services/timelineNamePreference.js'
import { useHiddenTaskPreference } from '../src/services/hiddenTaskPreference.js'
import { createTaskDraftStore } from '../src/stores/taskDraftStore.js'
const common = { start: '09:00:00', finish: '09:05:00', bot: 'A', version: 1, can_edit: true, schedule_uuid: 'a' }
const tasks = [{ ...common, id: '1', task: '普通任务甲', is_hidden: true },
  { ...common, id: '2', task: '循环任务乙', timing_mode: 'cron' },
  { ...common, id: '3', task: '共享任务丙', schedule_dispatch: { execute_scope: 'any', clients: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } }]
const button = (wrapper, label) => wrapper.findAll('button').find(item => item.text() === label)
afterEach(() => vi.useRealTimers())
describe('隐藏任务设置', () => {
  it('设置中的自动滚动开关保存原Cookie，重新进入保持选择', async () => {
    const preference = useTimelineAutoScrollPreference()
    preference.save(false)
    const wrapper = mount(HiddenTasksDialog, { props: { show: true, tasks, autoScroll: preference.enabled.value } })
    await wrapper.get('[aria-label="自动滚动"]').trigger('click')
    expect(wrapper.emitted('update:autoScroll')).toEqual([[true]])
    preference.save(wrapper.emitted('update:autoScroll')[0][0])
    expect(useTimelineAutoScrollPreference().enabled.value).toBe(true)
    preference.save(false)
    wrapper.unmount()
  })
  it('8:30和17:30参考线默认开启，可以从设置关闭并保存Cookie', async () => {
    document.cookie = 'pytaskgantt.showReferenceLines=; Max-Age=0; Path=/'
    const preference = useReferenceLinesPreference()
    expect(preference.enabled.value).toBe(true)
    const wrapper = mount(HiddenTasksDialog, { props: { show: true, tasks } })
    await wrapper.get('[aria-label="显示参考线"]').trigger('click')
    expect(wrapper.emitted('update:showReferenceLines')).toEqual([[false]])
    preference.save(false)
    expect(useReferenceLinesPreference().enabled.value).toBe(false)
    preference.save(true)
    wrapper.unmount()
  })

  it('当前时间线在设置中默认关闭，Cookie保留切换状态且独立于自动滚动', async () => {
    document.cookie = 'pytaskgantt.showCurrentTimeLine=; Max-Age=0; Path=/'
    const preference = useCurrentTimeLinePreference()
    expect(preference.enabled.value).toBe(false)
    const wrapper = mount(HiddenTasksDialog, { props: { show: true, tasks } })
    await wrapper.get('[aria-label="显示当前时间线"]').trigger('click')
    expect(wrapper.emitted('update:showCurrentTimeLine')).toEqual([[true]])
    preference.save(true)
    expect(useCurrentTimeLinePreference().enabled.value).toBe(true)
    preference.save(false)
    wrapper.unmount()
  })
  it('显示隐藏任务在设置里默认关闭，切换即时生效且不保存名单', async () => {
    const wrapper = mount(HiddenTasksDialog, { props: { show: true, tasks } })
    const control = wrapper.get('[aria-label="显示隐藏任务"]')
    expect(control.attributes('aria-checked')).toBe('false')
    await control.trigger('click')
    expect(wrapper.emitted('update:showHiddenTasks')).toEqual([[true]])
    expect(wrapper.emitted('save')).toBeUndefined()
    wrapper.unmount()
  })
  it('设置提供默认关闭的运行状态开关，不改变任务配置', async () => {
    const wrapper = mount(HiddenTasksDialog, { props: { show: true, tasks } })
    const control = wrapper.get('[aria-label="显示今日运行状态"]')
    expect(control.attributes('aria-checked')).toBe('false')
    await control.trigger('click')
    expect(wrapper.emitted('update:showRunStatus')).toEqual([[true]])
    expect(wrapper.emitted('save')).toBeUndefined()
    wrapper.unmount()
  })
  it('设置提供任务名称开关，名称偏好默认开启并长期记住关闭选择', async () => {
    document.cookie = 'pytaskgantt.showTaskNames=; Max-Age=0; Path=/'
    const preference = useTimelineNamePreference()
    expect(preference.enabled.value).toBe(true)
    preference.save(false)
    expect(useTimelineNamePreference().enabled.value).toBe(false)
    const wrapper = mount(HiddenTasksDialog, { props: { show: true, tasks, showTaskNames: true } })
    await wrapper.get('[aria-label="任务条上显示名称"]').trigger('click')
    expect(wrapper.emitted('update:showTaskNames')).toEqual([[false]])
    expect(wrapper.emitted('save')).toBeUndefined()
    preference.save(true)
    wrapper.unmount()
  })

  it('先显示名单，添加时分类、搜索和选择；保存只提交实际变化', async () => {
    const wrapper = mount(HiddenTasksDialog, { props: { show: true, tasks } })
    expect(wrapper.find('.hidden-task-rows').exists()).toBe(false)
    expect(wrapper.text()).toContain('用竖线标记当前北京时间，随时间自动更新；默认关闭。')
    const setting = wrapper.findAll('.task-name-setting').find(row => row.find('[aria-label="显示隐藏任务"]').exists())
    expect(setting.text()).toContain('设置名单')
    expect(wrapper.findAll('.task-name-setting').some(row => row.find('strong').text() === '隐藏任务名单')).toBe(false)
    await button(wrapper, '设置名单').trigger('click')
    expect(wrapper.findAll('.hidden-task-name').map(row => row.text())).toEqual(['普通任务甲'])
    await button(wrapper, '添加').trigger('click')
    await button(wrapper, '循环任务').trigger('click')
    expect(wrapper.findAll('.hidden-task-name').map(row => row.text())).toEqual(['循环任务乙'])
    await button(wrapper, '共享任务').trigger('click')
    await wrapper.get('input:not([type=checkbox])').setValue('丙')
    expect(wrapper.findAll('.hidden-task-name').map(row => row.text())).toEqual(['共享任务丙'])
    await wrapper.get('input[type=checkbox]').setValue(true)
    await button(wrapper, '添加所选（1）').trigger('click')
    await wrapper.findAll('.hidden-task-row')[0].get('button').trigger('click')
    await button(wrapper, '保存名单').trigger('click')
    expect(wrapper.emitted('save')[0][0]).toEqual([{ id: '1', expected_hidden: true, is_hidden: false }, { id: '3', expected_hidden: false, is_hidden: true }])
    wrapper.unmount()
  })
  it('过滤按源任务隐藏所有候选条目；开关不再自动排除共享任务', () => {
    expect(filterTasks(tasks, { showHiddenTasks: false }).map(row => row.id).sort()).toEqual(['2', '3'])
    const hiddenShared = { ...tasks[2], is_hidden: true }
    expect(filterTasks(projectSharedTasks([hiddenShared]), { showHiddenTasks: false })).toEqual([])
    expect(filterTasks(projectSharedTasks([hiddenShared]), { showHiddenTasks: true })).toHaveLength(2)
  })
  it('新Cookie默认关闭，独立于旧共享任务偏好，重新进入保留状态', () => {
    document.cookie = 'pytaskgantt.showHiddenTasks=; Max-Age=0; Path=/'
    document.cookie = 'pytaskgantt.showSharedTasks=1; Path=/'
    const preference = useHiddenTaskPreference()
    expect(preference.enabled.value).toBe(false)
    preference.save(true)
    expect(useHiddenTaskPreference().enabled.value).toBe(true)
    preference.save(false)
  })
  it('已有预览草稿时合并隐藏标志，不覆盖预览时间', async () => {
    let rows = [tasks[0]]
    const store = createTaskDraftStore(async () => ({ tasks: rows }), undefined, { previewOnly: true })
    await store.load()
    store.updateTask('1', { start: '11:00:00' })
    rows = [{ ...tasks[0], is_hidden: false }]
    await store.load({ preserveDraft: true })
    await flushPromises()
    expect(store.tasks.value[0].start).toBe('11:00:00')
    expect(store.tasks.value[0].is_hidden).toBe(false)
  })
})
