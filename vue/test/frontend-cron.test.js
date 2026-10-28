import { describe, it, expect } from 'vitest'
import { parseYingdaoCron, cronTemplateSegments } from '../shared/yingdaoCron.mjs'
import { filterTasks } from '../src/services/dataService.js'

describe('影刀 Cron 每日模板', () => {
  it('按首个触发时刻排序，不使用循环模式残留的单段时间', () => {
    const rows = filterTasks([
      { id: 'single', task: '单段', bot: 'A', start: '06:00:00', finish: '07:00:00' },
      { id: 'cron', task: '循环', bot: 'A', start: '09:00:00', finish: '10:00:00', timing_mode: 'cron', schedule_cron_expression: '0 0-8/2 * * *', expected_duration_seconds: 60 },
    ], { sortBy: 'time' })
    expect(rows.map(row => row.id)).toEqual(['cron', 'single'])
    expect(rows[0].freqBadge).toBe('🔁')
  })
  it('包含 08:00，五个独立的一分钟片段', () => {
    expect(cronTemplateSegments('0 0-8/2 * * *', 60)).toEqual([0, 7200, 14400, 21600, 28800].map(start => ({ start, end: start + 60, last: start, count: 1 })))
  })
  it('支持列表、范围、数字起点步长及英文月和星期', () => {
    const value = parseYingdaoCron('0/15 8,10-12 * jan,DEC mon-fri')
    expect(value.seconds).toHaveLength(16)
    expect(value.months).toEqual([1, 12])
    expect(value.weekdays).toEqual([1, 2, 3, 4, 5])
    expect(parseYingdaoCron('0 8 31 FEB *').seconds).toEqual([28800])
  })
  it('全分钟最多 1440 次，缩小合并，放大可还原各次', () => {
    const expanded = cronTemplateSegments('* * * * *', 60)
    const compact = cronTemplateSegments('* * * * *', 60, 900)
    expect(expanded).toHaveLength(1440)
    expect(compact).toHaveLength(96)
    expect(compact.reduce((sum, item) => sum + item.count, 0)).toBe(1440)
    expect(compact[0]).toEqual({ start: 0, last: 840, end: 900, count: 15 })
  })
  it('跨天结束不截断', () => {
    expect(cronTemplateSegments('59 23 * * *', 120)[0].end).toBe(86460)
  })
  it.each(['0 0 0 * *', '60 * * * *', '0 24 * * *', '0 0 * 13 *', '0 0 * * 7', '*/0 * * * *', '*/61 * * * *', '0 8-0 * * *', '0, * * * *', '0 0 1 * MON', '0 0 ? * *', '0 0 0 * * *', '0 0 L * *'])('拒绝无效或 Quartz 表达式 %s', expression => {
    expect(() => parseYingdaoCron(expression)).toThrow()
  })
  it.each([0, 86401, 1.5, NaN])('拒绝非法预计时长 %s', duration => {
    expect(() => cronTemplateSegments('0 0 * * *', duration)).toThrow()
  })
})
