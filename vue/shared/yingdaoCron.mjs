// Yingdao's five-field dialect, not Quartz. Calendar fields are validated and
// retained, but this board is a daily template rather than a dated calendar.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function scheduleCronExpression(source = {}) {
  if (source.type === 'cron' && source.cronExpress) return parseYingdaoCron(source.cronExpress).expression;
  if (source.type === 'minute') {
    const interval = Number(source.minute);
    // Only lossless five-field conversions: e.g. 7-minute intervals must not
    // become */7, which would reset at each hour and change the schedule.
    if (!Number.isInteger(interval) || interval < 1 || interval > 60 || 60 % interval !== 0) throw new Error('该分钟间隔暂不能准确展开为每日模板');
    const clock = String(source.nextTime || '').match(/(?:T|\s)(\d{2}):(\d{2}):(\d{2})(?:$|[.Z+])/);
    if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3]) !== 0) throw new Error('影刀分钟规则缺少有效的触发基准时间');
    const minute = Number(clock[2]) % interval;
    return parseYingdaoCron(`${interval === 60 ? minute : `${minute}-59/${interval}`} * * * *`).expression;
  }
  throw new Error('影刀计划没有支持的循环定时规则');
}

function fieldValues(text, min, max, names = []) {
  const number = token => {
    const named = names.indexOf(token);
    const value = named >= 0 ? named + min : /^\d+$/.test(token) ? Number(token) : NaN;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Cron 字段超出范围 ${min}–${max}`);
    return value;
  };
  const result = new Set();
  for (const part of text.split(',')) {
    const pieces = part.split('/');
    if (!part || pieces.length > 2) throw new Error('Cron 列表或步长不正确');
    const [base, stepText] = pieces;
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : NaN;
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new Error('Cron 步长不正确');
    const range = base.split('-');
    if (range.length > 2 || range.some(value => !value)) throw new Error('Cron 范围不正确');
    const start = base === '*' ? min : number(range[0]);
    const end = base === '*' ? max : range.length === 2 ? number(range[1]) : stepText === undefined ? start : max;
    if (end < start) throw new Error('Cron 范围结束值不能小于开始值');
    for (let value = start; value <= end; value += step) result.add(value);
  }
  return [...result].sort((a, b) => a - b);
}

export function parseYingdaoCron(input) {
  if (typeof input !== 'string' || input.length > 200) throw new Error('Cron 表达式不正确');
  const parts = input.trim().toUpperCase().split(/\s+/);
  if (parts.length !== 5) throw new Error('影刀 Cron 需要五段：分 时 日 月 周');
  const [minute, hour, day, month, week] = parts;
  const minutes = fieldValues(minute, 0, 59);
  const hours = fieldValues(hour, 0, 23);
  const dates = fieldValues(day, 1, 31);
  const months = fieldValues(month, 1, 12, MONTHS);
  const weekdays = fieldValues(week, 0, 6, DAYS);
  if (day !== '*' && week !== '*') throw new Error('影刀 Cron 的日期与星期不能同时指定，至少一项需要为 *');
  const seconds = hours.flatMap(h => minutes.map(m => h * 3600 + m * 60));
  return { expression: parts.join(' '), seconds, dates, months, weekdays };
}

export function cronTemplateSegments(expression, durationSeconds = 60, bucketSeconds = 60) {
  const { seconds } = parseYingdaoCron(expression);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400) throw new Error('单次预计时长需要为 1–86400 秒');
  const groups = new Map();
  for (const start of seconds) {
    const key = Math.floor(start / Math.max(60, bucketSeconds));
    const segment = groups.get(key);
    if (segment) { segment.end = Math.max(segment.end, start + durationSeconds); segment.last = start; segment.count += 1; }
    else groups.set(key, { start, end: start + durationSeconds, last: start, count: 1 });
  }
  return [...groups.values()];
}

export function cronTemplateSummary(expression, durationSeconds = 60) {
  try {
    const { seconds } = parseYingdaoCron(expression);
    return `🔁 每日模板 ${seconds.length} 次 · 每次预计 ${durationSeconds} 秒`;
  } catch { return '🔁 规则待同步'; }
}
