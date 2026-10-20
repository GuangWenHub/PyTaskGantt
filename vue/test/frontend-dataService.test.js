import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  createBotColorMap,
  filterTasks,
  formatDuration,
  getBotColor,
  getTaskFrequencyBadge,
  isCrossDay,
  parseTimeToDate,
  summarizeSyncCutoff,
  getCurrentTimeWindow,
  DEFAULT_TIMELINE_WINDOW_MS,
} from '../src/services/dataService.js'

describe('frontend data utilities', () => {
  it.each([
    ['2026-10-20T06:00:00Z', '2025-01-01T11:30:00', '2025-01-01T16:30:00'],
    ['2026-10-19T16:15:00Z', '2024-12-31T21:45:00', '2025-01-01T02:45:00'],
    ['2026-10-20T15:45:00Z', '2025-01-01T21:15:00', '2025-01-02T02:15:00'],
  ])('按上海时间居中并保留跨天视窗：%s', (now, start, end) => {
    const window = getCurrentTimeWindow(new Date(now))
    expect(window).toEqual({ start: new Date(start), end: new Date(end) })
    expect(window.end - window.start).toBe(DEFAULT_TIMELINE_WINDOW_MS)
  })

  it('为不同机器人生成稳定且不受八色调色板限制的颜色', () => {
    expect(getBotColor('机器人1')).toBe(getBotColor('机器人1'))
    expect(getBotColor('机器人1')).not.toBe(getBotColor('机器人10'))

    const names = Array.from({ length: 10 }, (_, index) => `机器人${index}`)
    const colors = createBotColorMap(names)
    expect(new Set(colors.values()).size).toBe(names.length)

    const rows = names.map((bot, index) => ({
      id: String(index), task: `任务${index}`, start: '09:00:00', finish: '10:00:00', bot,
    }))
    const allRows = filterTasks(rows)
    const filteredRows = filterTasks(rows, { selectedBots: ['机器人1', '机器人8'] })
    expect(filteredRows.map(row => row.color)).toEqual([
      allRows.find(row => row.bot === '机器人1').color,
      allRows.find(row => row.bot === '机器人8').color,
    ])
  })

  it('保留跨天任务语义', () => {
    expect(isCrossDay('23:30:00', '01:15:00')).toBe(true)
    expect(formatDuration('23:30:00', '01:15:00')).toBe('1h 45m')
    const { start, end } = parseTimeToDate('23:30:00', '01:15:00')
    expect(end.getTime() - start.getTime()).toBe(105 * 60 * 1000)
  })

  it('转义甘特 group 中的用户输入', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })

  it('按所有者过滤并保留历史任务入口', () => {
    const rows = [
      { id: '1', task: '我的任务', start: '09:00:00', finish: '09:30:00', bot: 'A', owner: { id: 'u1' } },
      { id: '2', task: '历史任务', start: '10:00:00', finish: '10:30:00', bot: 'B', owner: null },
    ]
    expect(filterTasks(rows, { selectedOwners: ['legacy'] }).map(row => row.id)).toEqual(['2'])
  })

  it('影刀数据截至取已绑定任务的最早成功同步时间且标记缺失项', () => {
    expect(summarizeSyncCutoff([
      { schedule_uuid: 's1', last_synced_at: '2026-07-22T04:00:00.000Z' },
      { schedule_uuid: 's2', last_synced_at: '2026-07-22T04:05:00.000Z' },
      { schedule_uuid: 's3', last_synced_at: null },
      { schedule_uuid: '', last_synced_at: null },
    ])).toEqual({
      boundCount: 3,
      timestamp: '2026-07-22T04:00:00.000Z',
      incomplete: true,
    })
  })
})

describe('getTaskFrequencyBadge 任务周期 emoji', () => {
  it('单一周期：每日 ☀️', () => {
    expect(getTaskFrequencyBadge(['每日'])).toEqual({ badge: '☀️', faded: false })
  })
  it('单一周期：每周（不分周几）⭐', () => {
    expect(getTaskFrequencyBadge(['每周'])).toEqual({ badge: '⭐', faded: true })
    expect(getTaskFrequencyBadge(['每周五'])).toEqual({ badge: '⭐', faded: true })
    expect(getTaskFrequencyBadge(['每周一'])).toEqual({ badge: '⭐', faded: true })
  })
  it('单一周期：每月 🌙', () => {
    expect(getTaskFrequencyBadge(['每月'])).toEqual({ badge: '🌙', faded: true })
  })
  it('多标签：每日+每月 → ☀️🌙，含每日不淡化', () => {
    expect(getTaskFrequencyBadge(['每日', '每月'])).toEqual({ badge: '☀️🌙', faded: false })
  })
  it('多标签：每周+每月 → ⭐🌙，无每日则淡化', () => {
    expect(getTaskFrequencyBadge(['每周', '每月'])).toEqual({ badge: '⭐🌙', faded: true })
  })
  it('三标签：每日+每周+每月 → ☀️⭐🌙，顺序固定', () => {
    expect(getTaskFrequencyBadge(['每日', '每周', '每月'])).toEqual({ badge: '☀️⭐🌙', faded: false })
  })
  it('顺序不跟随 tags 数组：[每月,每日] 仍输出 ☀️🌙', () => {
    expect(getTaskFrequencyBadge(['每月', '每日'])).toEqual({ badge: '☀️🌙', faded: false })
  })
  it('无周期标签 → 空串，不淡化', () => {
    expect(getTaskFrequencyBadge(['其他标签'])).toEqual({ badge: '', faded: false })
  })
  it('空数组 / 非数组入参 → 空串，不淡化', () => {
    expect(getTaskFrequencyBadge([])).toEqual({ badge: '', faded: false })
    expect(getTaskFrequencyBadge(undefined)).toEqual({ badge: '', faded: false })
    expect(getTaskFrequencyBadge(null)).toEqual({ badge: '', faded: false })
  })
  it('不误匹配英文关键词', () => {
    expect(getTaskFrequencyBadge(['daily'])).toEqual({ badge: '', faded: false })
    expect(getTaskFrequencyBadge(['weekly', 'monthly'])).toEqual({ badge: '', faded: false })
  })
  it('含空串/空白的 tags 被过滤后判定', () => {
    expect(getTaskFrequencyBadge(['', '每日', '  '])).toEqual({ badge: '☀️', faded: false })
  })
  it('decorateTask 把周期标记挂到任务上', () => {
    const [row] = filterTasks([
      { id: '1', task: '周报', start: '09:00:00', finish: '10:00:00', bot: 'A', tags: ['每周五'] },
    ])
    expect(row.freqBadge).toBe('⭐')
    expect(row.freqFaded).toBe(true)
  })
})
