import { apiRequest, toQuery } from './apiClient.js'

export const HISTORY_ACTIONS = {
  create: '新增任务', update: '修改任务', delete: '删除任务', import: '导入任务',
  rebind: '换绑计划', transfer: '转交任务', admin_recover: '恢复历史任务',
  run_now: '立即执行', restore: '还原任务',
}
export const HISTORY_FIELDS = {
  task: '任务名称', start: '开始时间', finish: '结束时间', bot: '机器人', tags: '标签',
  note: '任务备注', owner_user_id: '所有者', schedule_uuid: '计划 UUID', bound: '绑定状态', deleted: '任务状态',
  timing_mode: '排班模式', expected_duration_seconds: '单次预计时长（秒）',
}

export function historyValue(field, value, owners = {}) {
  if (field === 'timing_mode') return value === 'cron' ? '🔁 循环任务' : '单段排班';
  if (field === 'deleted') return value ? '已删除' : '有效'
  if (field === 'bound') return value ? '已绑定' : '未绑定'
  if (field === 'owner_user_id') return value ? owners[value] || `用户 ${value}` : '未分配'
  if (Array.isArray(value)) return value.join('、') || '无'
  return value == null || value === '' ? '无' : String(value)
}

export function historyChanges(before, after) {
  if (!before || !after) return []
  return Object.keys(HISTORY_FIELDS).filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
}

export function getTaskHistory(filters = {}) {
  return apiRequest(`/task-history${toQuery(filters)}`)
}
export function saveHistoryAnnotation(id, annotation, version) {
  return apiRequest(`/task-history/${encodeURIComponent(id)}/annotation`, { method: 'PATCH', body: { annotation, version } })
}
export function previewHistoryRestore(id) {
  return apiRequest(`/task-history/${encodeURIComponent(id)}/restore-preview`)
}
export function restoreHistory(id, version) {
  return apiRequest(`/task-history/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { version } })
}
