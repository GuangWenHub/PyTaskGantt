import { apiRequest, downloadFromApi, toQuery } from './apiClient.js'

export function normalizeUser(user) {
  if (!user) return null
  return {
    ...user,
    id: user.id == null ? null : String(user.id),
    display_name: user.display_name || user.name || `用户 ${user.id}`,
  }
}

export function normalizeTask(raw = {}) {
  return {
    ...raw,
    id: raw.id == null ? null : String(raw.id),
    task: raw.task || '',
    start: raw.start || raw.start_time || '00:00:00',
    finish: raw.finish || raw.finish_time || '00:00:00',
    bot: raw.bot || '',
    schedule_dispatch: raw.schedule_dispatch || {},
    schedule_dispatch_synced_at: raw.schedule_dispatch_synced_at || null,
    schedule_dispatch_error: raw.schedule_dispatch_error || '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : [],
    note: raw.note || '',
    timing_mode: raw.timing_mode === 'cron' ? 'cron' : 'single',
    expected_duration_seconds: Number(raw.expected_duration_seconds || 60),
    schedule_cron_expression: raw.schedule_cron_expression || '',
    schedule_cron_synced_at: raw.schedule_cron_synced_at || null,
    schedule_cron_error: raw.schedule_cron_error || '',
    schedule_uuid: raw.schedule_uuid || '',
    schedule_name: raw.schedule_name || raw.schedule?.schedule_name || '',
    is_hidden: Boolean(raw.is_hidden),
    version: Number(raw.version || 1),
    owner: normalizeUser(raw.owner),
    created_by: normalizeUser(raw.created_by),
    can_edit: Boolean(raw.can_edit),
    is_legacy_unbound: Boolean(raw.is_legacy_unbound),
    normalized_status: raw.normalized_status || '待运行',
    last_run_at: raw.last_run_at || null,
    last_synced_at: raw.last_synced_at || null,
    sync_error: raw.sync_error || '',
  }
}

function normalizeTaskPayload(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.tasks || []
  const rawSyncCutoff = Array.isArray(payload) ? null : payload?.sync_cutoff
  return {
    tasks: rows.map(normalizeTask),
    serverTime: payload?.server_time || null,
    syncCutoff: rawSyncCutoff ? {
      boundCount: Number(rawSyncCutoff.bound_count || 0),
      timestamp: rawSyncCutoff.timestamp || null,
      incomplete: Boolean(rawSyncCutoff.incomplete),
    } : null,
  }
}

export async function getTasks() {
  return normalizeTaskPayload(await apiRequest('/tasks'))
}

export async function getMyTasks(params = {}) {
  return normalizeTaskPayload(await apiRequest(`/my/tasks${toQuery(params)}`))
}

export async function getUsers() {
  const payload = await apiRequest('/users')
  return (Array.isArray(payload) ? payload : payload?.users || []).map(normalizeUser)
}

export async function saveTaskMutations(mutations) {
  const payload = await apiRequest('/tasks/batch', {
    method: 'POST',
    body: { mutations },
  })
  return {
    ...payload,
    tasks: (payload?.tasks || []).map(normalizeTask),
    id_map: payload?.id_map || {},
  }
}

export function previewTaskImport(content, format) {
  return apiRequest('/import/preview', { method: 'POST', body: { content, format } })
}

export function importTasks(content, format, indices) {
  return apiRequest('/import', { method: 'POST', body: { content, format, indices } })
}

export function exportTasks(format, taskIds) {
  const suffix = format === 'json' ? 'json' : 'csv'
  return downloadFromApi(`/export/${suffix}`, `tasks_${new Date().toISOString().slice(0, 10)}.${suffix}`,
    taskIds === undefined ? undefined : { body: { task_ids: taskIds } })
}

export function rebindTask(taskId, scheduleUuid, version) {
  return apiRequest(`/tasks/${encodeURIComponent(taskId)}/rebind`, {
    method: 'POST',
    body: { schedule_uuid: scheduleUuid, version },
  })
}

export function transferTask(taskId, targetUserId, version) {
  return apiRequest(`/tasks/${encodeURIComponent(taskId)}/transfer`, {
    method: 'POST',
    body: { target_user_id: targetUserId, version },
  })
}

export function recoverTask(taskId, ownerUserId, scheduleUuid, version) {
  return apiRequest(`/admin/tasks/${encodeURIComponent(taskId)}/recover`, {
    method: 'POST',
    body: { owner_user_id: ownerUserId, schedule_uuid: scheduleUuid, version },
  })
}

export function runTask(taskId, expectedScheduleUuid) {
  return apiRequest(`/tasks/${encodeURIComponent(taskId)}/run`, {
    method: 'POST', body: { expected_schedule_uuid: expectedScheduleUuid },
  })
}

export function syncTask(taskId) {
  return apiRequest(`/tasks/${encodeURIComponent(taskId)}/sync`, { method: 'POST', body: {} })
}

export function syncAllTasks() {
  return apiRequest('/tasks/sync', { method: 'POST' })
}

export function syncMyTasks() {
  return apiRequest('/my/tasks/sync', { method: 'POST', body: {} })
}

function optionalNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

export function normalizeExecutionPayload(payload, params = {}) {
  const executions = Array.isArray(payload) ? payload : payload?.executions || []
  const pageInfo = payload?.pagination || (payload?.page && typeof payload.page === 'object' ? payload.page : {})
  const limit = Math.max(1, optionalNumber(pageInfo.limit, pageInfo.size, params.limit, params.size) || 20)
  const offset = Math.max(0, optionalNumber(pageInfo.offset, params.offset) || 0)
  const total = optionalNumber(pageInfo.total, payload?.total)
  const explicitHasMore = pageInfo.has_more ?? pageInfo.hasMore ?? payload?.has_more ?? payload?.hasMore
  const hasMore = explicitHasMore == null
    ? (total == null ? executions.length >= limit && executions.length > 0 : offset + executions.length < total)
    : Boolean(explicitHasMore)
  return {
    executions,
    pagination: { limit, offset, total, has_more: hasMore },
  }
}

export async function getTaskExecutions(taskId, params = {}) {
  const payload = await apiRequest(`/tasks/${encodeURIComponent(taskId)}/executions${toQuery(params)}`)
  return normalizeExecutionPayload(payload, params)
}

export async function setTaskVisibility(changes) {
  return apiRequest('/tasks/visibility', { method: 'PATCH', body: { changes } })
}
