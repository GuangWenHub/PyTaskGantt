import { parseYingdaoCron } from './yingdaoCron.mjs'
import { RUN_STATUS_COLORS as colors } from './runStatusColors.mjs'
const seconds = value => String(value || '00:00:00').split(':').reduce((n, part) => n * 60 + Number(part), 0)
function bucket(slots, value) {
  let lo = 0, hi = slots.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (slots[mid] <= value) lo = mid + 1; else hi = mid }
  return lo - 1
}
function stateOf(status) {
  if (status === '运行成功') return 'success'
  if (['运行中', '等待中'].includes(status)) return 'active'
  if (['运行失败', '运行超时', '等待超时', '已停止'].includes(status)) return 'error'
  return 'unknown'
}
export function taskRunIndicators(task, payload = {}) {
  const metadata = payload.tasks?.find(row => String(row.id) === String(task.id))
  const dayStart = Date.parse(`${payload.date}T00:00:00+08:00`)
  let slots
  try { slots = task.timing_mode === 'cron' ? parseYingdaoCron(task.schedule_cron_expression).seconds : [seconds(task.start)] }
  catch { slots = [] }
  let note = ''
  if (!/^[1-9]\d*$/.test(String(task.id)) || !task.schedule_uuid) note = '临时预览或未绑定计划，暂无运行记录'
  else if (!metadata) note = payload.error || '正在读取今日运行记录'
  else if (metadata.schedule_uuid !== task.schedule_uuid || String(metadata.schedule_bound_at) !== String(task.schedule_bound_at)) note = '任务绑定已变化，正在重新核对'
  else if (task.timing_mode === 'cron' && (metadata.schedule_cron_expression || '') !== (task.schedule_cron_expression || '')) note = '显示规则与已同步规则不同，无法匹配运行记录'
  const bySlot = new Map(), unknownMachineSlots = new Set()
  const records = (payload.records || []).filter(row => String(row.task_id) === String(task.id) && row.schedule_uuid === task.schedule_uuid)
    .sort((a, b) => Date.parse(a.trigger_time) - Date.parse(b.trigger_time) || Date.parse(a.updated_time || a.trigger_time) - Date.parse(b.updated_time || b.trigger_time))
  if (!note && Number.isFinite(dayStart)) for (const record of records) {
    const time = Date.parse(record.trigger_time), second = Math.floor((time - dayStart) / 1000)
    if (second < 0 || second >= 86400) continue
    const index = task.timing_mode === 'cron' ? bucket(slots, second) : 0
    if (task.shared_candidate && !record.client_ids?.includes(String(task.candidate_client?.id))) {
      if (!record.client_ids?.length && index >= 0) unknownMachineSlots.add(slots[index])
      continue
    }
    if (index >= 0) bySlot.set(slots[index], record)
  }
  return (first = slots[0], last = first) => {
    const selected = slots.filter(slot => slot >= first && slot <= last)
    const pendingNote = metadata?.state === 'error' ? (metadata.error || '今日记录读取失败') : metadata?.state === 'idle' ? '等待核对今日运行记录' : metadata?.state !== 'ready' ? '正在更新今日运行记录' : ''
    const states = selected.map(slot => {
      const record = bySlot.get(slot)
      const missingMachine = !record && unknownMachineSlots.has(slot) ? '实际机器信息未返回，暂无法匹配候选机器' : ''
      return { state: note ? 'unknown' : record ? stateOf(record.status) : pendingNote || missingMachine ? 'unknown' : 'idle', label: note || record?.status || pendingNote || missingMachine || (task.shared_candidate ? '该候选机器尚未执行' : '未运行') }
    })
    if (!states.length) states.push({ state: 'unknown', label: note || '无法匹配该触发时刻' })
    const counts = states.reduce((result, value) => { result[value.label] = (result[value.label] || 0) + 1; return result }, {})
    const gradient = states.map((value, index) => `${colors[value.state]} ${index / states.length * 100}% ${(index + 1) / states.length * 100}%`).join(',')
    return { background: `linear-gradient(to right, ${gradient})`, hint: `${payload.date || '今日'}：${Object.entries(counts).map(([label, count]) => `${label}${states.length > 1 ? ` ${count} 次` : ''}`).join('，')}${pendingNote && records.length ? `；${pendingNote}` : ''}` }
  }
}
