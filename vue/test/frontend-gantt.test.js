// @vitest-environment jsdom

import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentTimeWindow } from '../src/services/dataService.js'

const timelineState = vi.hoisted(() => ({ instances: [] }))

vi.mock('vis-data', () => {
  class DataSet {
    constructor(rows = []) {
      this.rows = new Map(rows.map(row => [row.id, { ...row }]))
    }

    get(id) {
      return this.rows.get(id)
    }

    getIds() {
      return [...this.rows.keys()]
    }

    update(rows) {
      const values = Array.isArray(rows) ? rows : [rows]
      for (const row of values) {
        this.rows.set(row.id, { ...(this.rows.get(row.id) || {}), ...row })
      }
    }

    remove(ids) {
      for (const id of Array.isArray(ids) ? ids : [ids]) this.rows.delete(id)
    }
  }

  return { DataSet }
})

vi.mock('vis-timeline/standalone', () => ({
  Timeline: class Timeline {
    constructor(container, items, groups, options) {
      this.container = container
      this.items = items
      this.groups = groups
      this.options = options
      this.handlers = {}
      this.customTimes = new Map()
      timelineState.instances.push(this)
    }

    on(event, handler) {
      this.handlers[event] = handler
    }

    destroy() {}
    fit() {}
    redraw() {
      this.redrawCalls = (this.redrawCalls || 0) + 1
    }
    addCustomTime(time, id) {
      this.customTimes.set(id, { time })
    }
    setCustomTimeTitle(title, id) {
      this.customTimes.get(id).title = title
    }
    setWindow(start, end, options) {
      this.window = { start, end }
      this.windowOptions = options
      this.setWindowCalls = (this.setWindowCalls || 0) + 1
      this.handlers.rangechange?.()
      this.handlers.rangechanged?.()
    }
    getWindow() {
      return this.window || {
        start: new Date('2025-01-01T08:00:00'),
        end: new Date('2025-01-01T13:00:00'),
      }
    }
  },
}))

import GanttChart from '../src/components/GanttChart.vue'

function task(overrides = {}) {
  return {
    id: '1',
    task: '每日对账',
    start: '09:00:00',
    finish: '09:30:00',
    bot: '财务机器人',
    owner: { id: '1', display_name: '用户甲' },
    can_edit: true,
    ...overrides,
  }
}

describe('GanttChart ownership boundary', () => {
  beforeEach(() => {
    document.cookie = 'pytaskgantt.timelineAutoScroll=; Max-Age=0; Path=/'
    timelineState.instances.length = 0
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T06:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('首次绘制后滑到当前时间，任务轮询刷新不重置用户视窗', async () => {
    document.cookie = 'pytaskgantt.timelineAutoScroll=1; Path=/'
    const wrapper = mount(GanttChart, {
      props: { tasks: [] },
      global: {
        stubs: {
          NCard: { template: '<section><slot name="header"/><slot/><slot name="header-extra"/></section>' },
          NSpace: { template: '<div><slot/></div>' },
          NButton: { template: '<button><slot/></button>' },
          NEmpty: { template: '<div />' },
          teleport: true,
        },
      },
    })
    const timeline = timelineState.instances.at(-1)
    expect(timeline.window).toBeUndefined()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(timeline.window).toEqual(getCurrentTimeWindow())
    expect(timeline.windowOptions.animation).toEqual({ duration: 1200, easingFunction: 'easeInOutQuad' })
    expect(timeline.options.min.getTime()).toBeLessThanOrEqual(new Date('2024-12-31T21:30:00').getTime())

    const chosenWindow = { start: new Date('2025-01-01T09:00:00'), end: new Date('2025-01-01T10:00:00') }
    timeline.setWindow(chosenWindow.start, chosenWindow.end)
    await wrapper.setProps({ tasks: [task()] })
    expect(timeline.window).toEqual(chosenWindow)
    expect(timeline.setWindowCalls).toBe(2)
    wrapper.unmount()
  })

  it('默认关闭自动定位，开启和关闭写 Cookie，重新进入恢复选择', async () => {
    const mountChart = () => mount(GanttChart, {
      props: { tasks: [] },
      global: { stubs: {
        NCard: { template: '<section><slot name="header"/><slot/><slot name="header-extra"/></section>' },
        NSpace: { template: '<div><slot/></div>' }, NButton: { template: '<button><slot/></button>' },
        NEmpty: { template: '<div />' }, teleport: true,
      } },
    })
    const waitFrames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    let wrapper = mountChart()
    await waitFrames()
    expect(timelineState.instances.at(-1).setWindowCalls).toBeUndefined()
    let toggle = wrapper.findAll('button').find(button => button.text() === '自动滚动')
    expect(toggle.attributes('aria-pressed')).toBe('false')
    await toggle.trigger('click')
    expect(document.cookie).toContain('pytaskgantt.timelineAutoScroll=1')
    expect(timelineState.instances.at(-1).window).toEqual(getCurrentTimeWindow())
    wrapper.unmount()
    wrapper = mountChart()
    await waitFrames()
    expect(timelineState.instances.at(-1).setWindowCalls).toBe(1)
    toggle = wrapper.findAll('button').find(button => button.text() === '自动滚动')
    expect(toggle.attributes('aria-pressed')).toBe('true')
    await toggle.trigger('click')
    expect(document.cookie).toContain('pytaskgantt.timelineAutoScroll=0')
    wrapper.unmount()
    wrapper = mountChart()
    await waitFrames()
    expect(timelineState.instances.at(-1).setWindowCalls).toBeUndefined()
    await wrapper.findAll('button').find(button => button.text() === '重置').trigger('click')
    expect(timelineState.instances.at(-1).window).toEqual(getCurrentTimeWindow())
    wrapper.unmount()
  })

  it('切回标签页或窗口恢复焦点时按新时间定位，合并重复事件；关闭和卸载后不触发', async () => {
    document.cookie = 'pytaskgantt.timelineAutoScroll=1; Path=/'
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const wrapper = mount(GanttChart, {
      props: { tasks: [] },
      global: { stubs: {
        NCard: { template: '<section><slot name="header"/><slot/><slot name="header-extra"/></section>' },
        NSpace: { template: '<div><slot/></div>' }, NButton: { template: '<button><slot/></button>' },
        NEmpty: { template: '<div />' }, teleport: true,
      } },
    })
    const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await frames()
    const timeline = timelineState.instances.at(-1)
    expect(timeline.setWindowCalls).toBe(1)
    window.dispatchEvent(new Event('blur'))
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    vi.setSystemTime(new Date('2026-10-20T06:10:00Z'))
    window.dispatchEvent(new Event('focus'))
    await frames()
    expect(timeline.setWindowCalls).toBe(1)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await frames()
    expect(timeline.setWindowCalls).toBe(2)
    expect(timeline.window).toEqual(getCurrentTimeWindow())
    // Already centered: a new activation does not replay the animation.
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
    await frames()
    expect(timeline.setWindowCalls).toBe(2)
    // Window focus alone also works after time has advanced.
    window.dispatchEvent(new Event('blur'))
    vi.setSystemTime(new Date('2026-10-20T06:20:00Z'))
    window.dispatchEvent(new Event('focus'))
    await frames()
    expect(timeline.setWindowCalls).toBe(3)
    await wrapper.findAll('button').find(button => button.text() === '自动滚动').trigger('click')
    window.dispatchEvent(new Event('blur'))
    vi.setSystemTime(new Date('2026-10-20T06:30:00Z'))
    window.dispatchEvent(new Event('focus'))
    await frames()
    expect(timeline.setWindowCalls).toBe(3)
    wrapper.unmount()
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
    await frames()
    expect(timeline.setWindowCalls).toBe(3)
    visibility.mockRestore()
  })

  it('只允许 can_edit 任务拖拽，并将自己的新时间作为 mutation 事件上报', async () => {
    const editable = task()
    const locked = task({
      id: '2',
      task: '他人任务',
      owner: { id: '2', display_name: '用户乙' },
      can_edit: false,
    })
    const wrapper = mount(GanttChart, {
      props: { tasks: [editable, locked] },
      global: {
        stubs: {
          NCard: { template: '<section><slot name="header"/><slot/><slot name="header-extra"/></section>' },
          NSpace: { template: '<div><slot/></div>' },
          NButton: { template: '<button><slot/></button>' },
          NEmpty: { template: '<div />' },
          teleport: true,
        },
      },
    })
    await nextTick()

    const timeline = timelineState.instances.at(-1)
    expect(timeline).toBeTruthy()
    expect(timeline.options.height).toBe('100%')
    expect(timeline.options.maxHeight).toBeUndefined()
    expect(timeline.options.start).toEqual(new Date('2025-01-01T00:00:00'))
    expect(timeline.options.end).toEqual(new Date('2025-01-01T05:00:00'))
    const reference = {
      time: new Date('2025-01-01T08:30:00'),
      title: '',
    }
    expect([...timeline.customTimes.values()]).toEqual([reference])
    const container = wrapper.get('.gantt-container')
    expect(container.classes()).not.toContain('gantt-reference-easter-egg')
    timeline.setWindow(new Date('2025-01-01T08:28:00'), new Date('2025-01-01T08:33:00'))
    await nextTick()
    expect(container.classes()).toContain('gantt-reference-easter-egg')
    timeline.setWindow(new Date('2025-01-01T08:28:00'), new Date('2025-01-01T08:33:01'))
    await nextTick()
    expect(container.classes()).not.toContain('gantt-reference-easter-egg')
    timeline.setWindow(new Date('2025-01-01T08:28:00'), new Date('2025-01-01T08:33:00'))
    await nextTick()
    await wrapper.findAll('button').find(button => button.text() === '重置').trigger('click')
    expect(container.classes()).not.toContain('gantt-reference-easter-egg')
    expect(timeline.window).toEqual(getCurrentTimeWindow())

    const ganttViewport = wrapper.get('.gantt-viewport').element
    const originalInnerHeight = window.innerHeight
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
    let viewportTop = 1000
    ganttViewport.getBoundingClientRect = () => ({ top: viewportTop })
    window.dispatchEvent(new Event('resize'))
    await new Promise(resolve => window.requestAnimationFrame(resolve))
    await nextTick()
    expect(ganttViewport.style.height).toBe('320px')

    viewportTop = 150
    window.dispatchEvent(new Event('scroll'))
    await new Promise(resolve => window.requestAnimationFrame(resolve))
    await nextTick()
    expect(ganttViewport.style.height).toBe('714px')

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 460 })
    window.dispatchEvent(new Event('resize'))
    await new Promise(resolve => window.requestAnimationFrame(resolve))
    await nextTick()
    expect(ganttViewport.style.height).toBe('320px')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })

    expect(timeline.items.get('1').editable).toMatchObject({ updateTime: true, updateGroup: false })
    expect(timeline.items.get('2').editable).toBe(false)
    expect(timeline.items.get('2').className).toContain('task-locked')

    const lockedCallback = vi.fn()
    timeline.options.onMoving({
      ...timeline.items.get('2'),
      start: new Date('2025-01-01T10:00:00'),
      end: new Date('2025-01-01T10:30:00'),
    }, lockedCallback)
    expect(lockedCallback).toHaveBeenCalledWith(null)
    expect(wrapper.emitted('task-update')).toBeUndefined()

    const editableCallback = vi.fn()
    timeline.options.onMove({
      ...timeline.items.get('1'),
      start: new Date('2025-01-01T10:15:00'),
      end: new Date('2025-01-01T11:05:00'),
    }, editableCallback)
    expect(editableCallback).toHaveBeenCalledOnce()
    expect(wrapper.emitted('task-update')).toEqual([[
      { id: '1', start: '10:15:00', finish: '11:05:00' },
    ]])

    await wrapper.setProps({ tasks: [] })
    await nextTick()
    expect(wrapper.get('.gantt-container').classes()).toContain('gantt-container-empty')
    expect(wrapper.get('.gantt-empty').element.parentElement).toBe(ganttViewport)

    await wrapper.setProps({ tasks: [editable] })
    await nextTick()
    expect(wrapper.get('.gantt-container').classes()).not.toContain('gantt-container-empty')
    expect(timeline.redrawCalls).toBeGreaterThan(0)
    expect([...timeline.customTimes.values()]).toEqual([reference])

    wrapper.unmount()
  })
})
