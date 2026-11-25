import { parseYingdaoCron, scheduleCronExpression } from './yingdaoCron.mjs'

export function formatElapsedTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '耗时未知'
  const total = Math.round(seconds)
  return [Math.floor(total / 3600), Math.floor(total % 3600 / 60), total % 60].map(n => String(n).padStart(2, '0')).join(':')
}

export function elapsedBetween(start, finish) {
  if (![start, finish].every(time => /^\d{2}:\d{2}:\d{2}$/.test(time || ''))) return null
  const seconds = time => time.split(':').reduce((total, n) => total * 60 + Number(n), 0)
  const delta = seconds(finish) - seconds(start)
  return delta < 0 ? delta + 86400 : delta
}

export function clockFromSeconds(seconds) {
  const value = ((seconds % 86400) + 86400) % 86400
  return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(n => String(n).padStart(2, '0')).join(':')
}

// 只按规则字段识别，不使用计划名称或 nextTime 猜测周期。
export function scheduleAutofill(source = {}) {
  let expression = '', start = '', timingMode = null, tags = []
  if (['cron', 'minute'].includes(source.type)) {
    const parsed = parseYingdaoCron(scheduleCronExpression(source))
    expression = parsed.expression
    timingMode = parsed.seconds.length > 1 ? 'cron' : 'single'
    start = clockFromSeconds(parsed.seconds[0])
    const [, , date, month, week] = expression.split(' ')
    if (date === '*' && month === '*' && week === '*') tags = ['每日']
    else if (date === '*' && month === '*' && week !== '*') tags = ['每周']
    else if (date !== '*' && month === '*' && week === '*') tags = ['每月']
  } else if (['day', 'week', 'month'].includes(source.type)) {
    const { hour, minute } = source
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('影刀规则缺少有效的小时或分钟')
    start = clockFromSeconds(hour * 3600 + minute * 60)
    timingMode = 'single'
    tags = [{ day: '每日', week: '每周', month: '每月' }[source.type]]
  } else if (source.type === 'timer') {
    const match = String(source.time || '').match(/(?:^|T|\s)(\d{2}):(\d{2})(?::(\d{2}))?(?:$|[.Z+])/)
    if (!match || +match[1] > 23 || +match[2] > 59 || +(match[3] || 0) > 59) throw new Error('单次计划缺少有效触发时间')
    start = `${match[1]}:${match[2]}:${match[3] || '00'}`
    timingMode = 'single'
  } else throw new Error('该计划的触发方式暂不能自动识别，请检查影刀控制台规则')
  return { timing_mode: timingMode, start, expression, tags }
}

export function suggestedFinish(start, seconds) {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(start || '') || !Number.isFinite(seconds)) return null
  const [h, m, s] = start.split(':').map(Number)
  return clockFromSeconds(h * 3600 + m * 60 + s + seconds)
}
