// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { machineColorError } from '../shared/machineColors.mjs'
import { RUN_STATUS_COLORS } from '../shared/runStatusColors.mjs'
import { useMachineColorPreference, applyMachineColors } from '../src/services/machineColorPreference.js'
import { readMachineColorCookies, renewDisplayPreferences, MACHINE_COLOR_COOKIE_PREFIX } from '../src/services/browserPreferences.js'
vi.mock('naive-ui', () => ({ NButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' } }))
import MachineColorsSettings from '../src/components/MachineColorsSettings.vue'
const preference = useMachineColorPreference()
afterEach(() => { vi.restoreAllMocks(); for (const name of Object.keys(preference.colors.value)) preference.reset(name) })
it('只排除状态原色及很近的色差，明显不同的深浅色不按整个色系禁用', () => {
  for (const color of [...Object.values(RUN_STATUS_COLORS), '#3c83f5', '#24a45b', '#e44e59', '#9da4b0']) expect(machineColorError(color)).not.toBe('')
  for (const color of ['#b7791f', '#a855b5', '#c59b18', '#2563eb', '#ffffff', '#000000', '#000080', '#006400', '#800000']) expect(machineColorError(color)).toBe('')
  expect(machineColorError('url(anything)')).not.toBe('')
})
it('颜色独立按机器写入Cookie、登录续期一年，拒绝无效颜色，恢复默认删除偏好', () => {
  expect(preference.save('机器甲@企业', '#a855b5')).toBe(true)
  expect(preference.save('机器甲@企业', RUN_STATUS_COLORS.success)).toBe(false)
  expect(readMachineColorCookies()['机器甲@企业']).toBe('#a855b5')
  const setter = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').set, writes = []
  vi.spyOn(document, 'cookie', 'set').mockImplementation(value => { writes.push(value); setter.call(document, value) })
  renewDisplayPreferences()
  expect(writes.find(value => value.startsWith(MACHINE_COLOR_COOKIE_PREFIX))).toContain('Max-Age=31536000')
  const rows = [{ id: '1', bot: '机器甲@企业', color: 'old', version: 2 }, { id: '2', bot: '其他机器', color: 'unchanged' }]
  const colored = applyMachineColors(rows, preference.colors.value)
  expect(colored[0].color).toBe('#a855b5'); expect(rows[0].color).toBe('old'); expect(colored[0].version).toBe(2)
  expect(colored[1].color).toBe('unchanged')
  preference.reset('机器甲@企业')
  expect(readMachineColorCookies()['机器甲@企业']).toBeUndefined()
})
it('调色板直接将禁用颜色置灰且无圆形覆盖，禁用色不能选择，允许颜色可应用和恢复', async () => {
  const wrapper = mount(MachineColorsSettings, { props: { tasks: [{ id: '1', task: '测试', bot: 'bot_1', start: '09:00:00', finish: '09:10:00' }] } })
  await wrapper.get('[aria-label="bot_1调色板"]').trigger('click')
  expect(wrapper.find('input[type=color]').exists()).toBe(false)
  expect(wrapper.findAll('.machine-palette-cell')).toHaveLength(264)
  expect(wrapper.find('.machine-palette-forbidden').exists()).toBe(false)
  const forbidden = wrapper.findAll('.machine-palette-cell').find(cell => cell.attributes('disabled') != null)
  expect(forbidden.element.style.background).toBe('rgb(155, 155, 155)')
  await forbidden.trigger('click')
  expect(preference.colors.value.bot_1).toBeUndefined()
  const allowed = wrapper.findAll('.machine-palette-cell').find(cell => cell.attributes('disabled') == null)
  const color = allowed.attributes('title')
  expect(machineColorError(color)).toBe('')
  await allowed.trigger('click')
  await wrapper.findAll('button').find(row => row.text() === '应用').trigger('click')
  expect(preference.colors.value.bot_1).toBe(color)
  expect(wrapper.get('[role=status]').text()).toContain('已保存')
  await wrapper.findAll('button').find(row => row.text() === '恢复默认').trigger('click')
  expect(preference.colors.value.bot_1).toBeUndefined()
  wrapper.unmount()
})
