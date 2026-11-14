export const reconciliationFields = ['task', 'bot', 'timing_mode', 'start', 'finish', 'schedule_dispatch', 'schedule_cron_expression']
export function ruleKey(row, field) {
  return JSON.stringify([String(row.task_id || ''), String(row.schedule_uuid || ''), field])
}
export function isUnscheduledEntry(row) {
  return row.kind === 'error' && (row.error_code === 'PLAN_UNSCHEDULED' || row.error === '手动触发计划没有固定排班时刻，请人工安排，不自动覆盖')
}
export function ignoredFields(row, rules) {
  if (row.kind !== 'update' || !row.task_id || !row.schedule_uuid) return []
  return rules.filter(rule => rule.task_id === String(row.task_id) && rule.schedule_uuid === row.schedule_uuid).map(rule => rule.field)
}
export function visibleEntries(entries, rules) {
  return (entries || []).filter(row => !row.applied && !isUnscheduledEntry(row) && !(row.kind === 'create' && row.enabled === false)).flatMap(row => {
    if (row.kind === 'create' && rules.some(rule => rule.field === 'plan' && rule.schedule_uuid === row.schedule_uuid)) return []
    if (row.kind !== 'update') return [row]
    const ignored = ignoredFields(row, rules)
    const fields = row.fields.filter(item => !ignored.includes(item.field))
    return fields.length ? [{ ...row, fields, ignored_fields: ignored }] : []
  })
}
