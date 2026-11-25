import { cronTemplateSummary, parseYingdaoCron } from '../../shared/yingdaoCron.mjs'
import { isSharedTask, candidateNames } from '../../shared/scheduleDispatch.mjs'
export const DUMMY_DATE = '2025-01-01'
export const DEFAULT_TIMELINE_WINDOW_MS = 5 * 60 * 60 * 1000

export function getCurrentTimeWindow(now = new Date()) {
  // 真实日期不能直接放入虚拟排班轴；只将上海时区的时分秒映射到虚拟日期。
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now)
  const clock = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const center = new Date(`${DUMMY_DATE}T${clock.hour}:${clock.minute}:${clock.second}`)
  return {
    start: new Date(center.getTime() - DEFAULT_TIMELINE_WINDOW_MS / 2),
    end: new Date(center.getTime() + DEFAULT_TIMELINE_WINDOW_MS / 2),
  }
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0
  const [hour = 0, minute = 0, second = 0] = String(timeStr).split(':').map(Number)
  return hour * 60 + minute + second / 60
}

export function normalizeTime(value) {
  if (!value) return '00:00:00'
  const segments = String(value).split(':')
  while (segments.length < 3) segments.push('00')
  return segments.slice(0, 3).map(segment => String(segment).padStart(2, '0')).join(':')
}

export function formatDuration(startTime, finishTime) {
  const startMinutes = timeToMinutes(startTime)
  let endMinutes = timeToMinutes(finishTime)
  if (endMinutes < startMinutes) endMinutes += 24 * 60
  const total = Math.round((endMinutes - startMinutes) * 60)
  const hours = Math.floor(total / 3600), mins = Math.floor(total % 3600 / 60), secs = total % 60
  return [hours && `${hours}h`, mins && `${mins}m`, secs && `${secs}s`].filter(Boolean).join(' ') || '0s'
}

export function isCrossDay(startTime, finishTime) {
  return timeToMinutes(finishTime) < timeToMinutes(startTime)
}

export function parseTimeToDate(startTime, finishTime) {
  const start = new Date(`${DUMMY_DATE}T${normalizeTime(startTime)}`)
  let end = new Date(`${DUMMY_DATE}T${normalizeTime(finishTime)}`)
  if (end < start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

function hashText(value) {
  const normalized = String(value || '').trim().normalize('NFKC')
  let hash = 0x811c9dc5
  for (const char of normalized) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  // FNV-1a 对相邻名称的末尾字符仍可能产生接近的值，再做一次 avalanche，
  // 避免“机器人1 / 机器人2”这类名称落到肉眼接近的连续色相。
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

export function getBotColor(botName) {
  if (String(botName || '').trim().normalize('NFKC').toLowerCase() === 'bot_1') return '#b7791f'
  const hash = hashText(botName)
  const hue = hash % 360
  const saturation = 62 + ((hash >>> 9) % 18)
  const lightness = 38 + ((hash >>> 17) % 8)
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

export function createBotColorMap(botNames = []) {
  const names = [...new Set(botNames
    .map(name => String(name || '').trim().normalize('NFKC'))
    .filter(Boolean))]
    .sort((left, right) => hashText(left) - hashText(right) || left.localeCompare(right, 'zh-CN'))
  if (!names.length) return new Map()

  // 按当前完整机器人集合等距分布色相，避免有限调色板取余造成重复；
  // 筛选前生成映射，筛选任务时颜色不会跟着变化。
  const rotation = hashText(names.join('\u0000')) % 360
  return new Map(names.map((name, index) => {
    const hash = hashText(name)
    const hue = Math.round((rotation + (index * 360) / names.length) % 360)
    const saturation = 64 + ((hash >>> 9) % 12)
    const lightness = 39 + ((hash >>> 17) % 5)
    return [name, name.toLowerCase() === 'bot_1' ? getBotColor(name) : `hsl(${hue}, ${saturation}%, ${lightness}%)`]
  }))
}

// 循环模式显示 🔁；其他周期依据 tags 数组，不解析任务名。
// 顺序固定 ☀️→⭐→🌙，不跟随 tags 数组顺序，保证同含义显示一致。
// 返回 { badge: string, faded: boolean }
//   badge: emoji 字符串（无匹配返回空串）
//   faded: 是否淡化（仅含每周/每月、不含每日时为 true）
const FREQ_RULES = [
  { match: '每日', emoji: '☀️' },
  { match: '每周', emoji: '⭐' },
  { match: '每月', emoji: '🌙' },
]

export function getTaskFrequencyBadge(tags = [], timingMode = 'single') {
  if (timingMode === 'cron') return { badge: '🔁', faded: false }
  if (!Array.isArray(tags) || !tags.length) return { badge: '', faded: false }
  const joined = tags.map(t => String(t || '').trim()).filter(Boolean)
  if (!joined.length) return { badge: '', faded: false }
  const text = joined.join('|')
  const emojis = []
  let hasDaily = false
  let hasWeeklyOrMonthly = false
  for (const rule of FREQ_RULES) {
    if (text.includes(rule.match)) {
      emojis.push(rule.emoji)
      if (rule.match === '每日') hasDaily = true
      else hasWeeklyOrMonthly = true
    }
  }
  return {
    badge: emojis.join(''),
    faded: !hasDaily && hasWeeklyOrMonthly,
  }
}

export function decorateTask(task, color = getBotColor(task.bot)) {
  const freq = getTaskFrequencyBadge(task.tags, task.timing_mode)
  let triggerSeconds = []
  if (task.timing_mode === 'cron') {
    try { triggerSeconds = parseYingdaoCron(task.schedule_cron_expression).seconds } catch { /* Wait for a valid remote rule. */ }
  }
  return {
    ...task,
    duration: task.timing_mode === 'cron' ? `单次预计 ${task.expected_duration_seconds || 60} 秒` : formatDuration(task.start, task.finish),
    cronSummary: task.timing_mode === 'cron' ? cronTemplateSummary(task.schedule_cron_expression, task.expected_duration_seconds || 60) : '',
    color,
    crossDay: task.timing_mode === 'cron' ? triggerSeconds.some(second => second + (task.expected_duration_seconds || 60) >= 86400) : isCrossDay(task.start, task.finish),
    sortStartMinutes: task.timing_mode === 'cron' ? (triggerSeconds[0] ?? 86400) / 60 : timeToMinutes(task.start),
    freqBadge: freq.badge,
    freqFaded: freq.faded,
  }
}

export function filterTasks(tasks, {
  searchTerm = '',
  selectedBots = [],
  selectedOwners = [],
  sortBy = 'bot',
  showSharedTasks = true,
  showHiddenTasks = true,
  preserveDecoration = false,
} = {}) {
  const botColors = createBotColorMap(tasks.map(task => task.bot))
  let rows = preserveDecoration ? [...tasks] : tasks.map(task => decorateTask(task, botColors.get(String(task.bot || '').trim().normalize('NFKC'))))
  const term = searchTerm.trim().toLocaleLowerCase('zh-CN')
  if (term) rows = rows.filter(task => task.task.toLocaleLowerCase('zh-CN').includes(term))
  if (!showHiddenTasks) rows = rows.filter(task => !task.is_hidden)
  if (!showSharedTasks) rows = rows.filter(task => !isSharedTask(task))
  if (selectedBots.length) rows = rows.filter(task => candidateNames(task).some(bot => selectedBots.includes(bot)))
  if (selectedOwners.length) {
    rows = rows.filter(task => selectedOwners.includes(task.owner?.id || 'legacy'))
  }
  rows.sort((left, right) => {
    if (sortBy === 'time') return left.sortStartMinutes - right.sortStartMinutes
    if (sortBy === 'owner') {
      const owner = (left.owner?.display_name || '').localeCompare(right.owner?.display_name || '', 'zh-CN')
      if (owner) return owner
    }
    const bot = left.bot.localeCompare(right.bot, 'zh-CN')
    return bot || left.sortStartMinutes - right.sortStartMinutes
  })
  return rows
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char])
}

export function statusType(status) {
  if (status === '运行成功') return 'success'
  if (['运行失败', '等待超时', '运行超时'].includes(status)) return 'error'
  if (['等待中', '运行中'].includes(status)) return 'info'
  if (status === '已停止') return 'warning'
  return 'default'
}

export function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date)
}

export function formatRunDateTime(value) {
  if (!value) return '—'
  const text = String(value).trim()
  // Yingdao's timestamps without an offset are Beijing time, regardless of the browser timezone.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}+08:00` : text
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return String(value)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', weekday: 'long', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.month}/${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute}:${parts.second}`
}

export function summarizeSyncCutoff(tasks = []) {
  const boundTasks = (Array.isArray(tasks) ? tasks : []).filter(task => task?.schedule_uuid)
  const timestamps = boundTasks
    .map(task => Date.parse(task.last_synced_at || ''))
    .filter(Number.isFinite)
  return {
    boundCount: boundTasks.length,
    timestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    incomplete: timestamps.length < boundTasks.length,
  }
}
