// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ClockTimePicker from '../src/components/ClockTimePicker.vue'
import DurationPicker from '../src/components/DurationPicker.vue'

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

it('点击耗时输入框展开滑条并保持可编辑焦点，图标也打开滑条', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const wrapper = mount(DurationPicker, { attachTo: document.body, props: { value: 180 } })
  const input = wrapper.get('input[aria-label="耗时"]')
  await input.trigger('click')
  await flushPromises()
  expect(document.activeElement).toBe(input.element)
  expect(wrapper.get('button').attributes('aria-expanded')).toBe('true')
  expect(document.querySelectorAll('.duration-sliders input[type="range"]')).toHaveLength(3)
  expect(document.querySelector('.duration-sliders strong')).toBeNull()
  await input.setValue('00:13:27')
  expect(wrapper.emitted('update:value').at(-1)).toEqual([807])
  await input.trigger('keydown', { key: 'Escape' })
  await flushPromises()
  expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.get('button').attributes('aria-expanded')).toBe('true')
  wrapper.unmount()
})

it('真实Popover打开后直接编辑时分秒三个小框，且位于body弹层而非卡片裁切区', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const wrapper = mount(ClockTimePicker, { attachTo: document.body, props: { value: '23:59:00', label: '结束时间' } })
  expect(wrapper.find('input').exists()).toBe(false)
  await wrapper.get('.clock-trigger').trigger('click')
  await flushPromises()
  expect(wrapper.get('.clock-trigger').attributes('aria-expanded')).toBe('true')
  expect(document.querySelector('.clock-unit[data-active="true"] span').textContent).toBe('分')
  expect(document.querySelector('.clock-footer .clock-units')).not.toBeNull()
  expect(document.querySelector('.clock-footer .clock-done')).not.toBeNull()
  const inputs = document.querySelectorAll('.clock-units input')
  expect(inputs).toHaveLength(3)
  expect(inputs[0].closest('.clock-time-picker')).toBeNull()
  expect(inputs[0].value).toBe('23')
  for (const [index, value] of ['08', '30', '01'].entries()) {
    inputs[index].value = value
    inputs[index].dispatchEvent(new Event('input', { bubbles: true }))
    inputs[index].dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
  }
  expect(wrapper.emitted('update:value').at(-1)).toEqual(['08:30:01'])
  const done = document.querySelector('.clock-done')
  inputs[2].focus()
  await flushPromises()
  done.click()
  await flushPromises()
  expect(wrapper.get('.clock-trigger').attributes('aria-expanded')).toBe('false')
  await wrapper.get('.clock-trigger').trigger('click')
  await flushPromises()
  expect(document.querySelector('.clock-unit[data-active="true"] span').textContent).toBe('分')
  wrapper.unmount()
})
