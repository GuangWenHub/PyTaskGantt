import { apiRequest } from './apiClient.js'
export function startPlanScan() { return apiRequest('/yingdao/reconciliation', { method: 'POST', body: {} }) }
export function getPlanScan(id) { return apiRequest(`/yingdao/reconciliation/${encodeURIComponent(id)}`) }
export function getPlanSyncState() { return apiRequest('/yingdao/reconciliation/state') }
export function changePlanWhitelist(rule, remove = false) {
  return apiRequest('/yingdao/reconciliation/whitelist', { method: remove ? 'DELETE' : 'POST', body: rule })
}
export function restorePlanWhitelist(rules) {
  return apiRequest('/yingdao/reconciliation/whitelist/batch', { method: 'DELETE', body: { rules } })
}
export function recheckPlanEntries(id, entryIds) {
  return apiRequest(`/yingdao/reconciliation/${encodeURIComponent(id)}/recheck`, { method: 'POST', body: { entry_ids: entryIds } })
}
export function applyPlanChanges(id, entryIds, form, { bulkCreate = false } = {}) {
  return apiRequest(`/yingdao/reconciliation/${encodeURIComponent(id)}/apply`, { method: 'POST', body: { entry_ids: entryIds, ...(form ? { form } : {}), ...(bulkCreate ? { bulk_create: true } : {}) } })
}
