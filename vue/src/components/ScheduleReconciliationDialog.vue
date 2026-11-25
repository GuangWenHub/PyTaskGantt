<template>
  <n-modal :show="show" preset="card" title="同步影刀计划" class="responsive-modal reconciliation-modal" :mask-closable="false" :closable="!applying" :close-on-esc="!applying" @update:show="value => $emit('update:show', value)">
    <n-alert v-if="error" type="error" class="page-alert">{{ error }}</n-alert>
    <div class="reconciliation-toolbar"><span v-if="job?.scanned_at">上次结果 {{ formatDateTime(job.scanned_at) }} · 一致 {{ job.unchanged }} 条 · 已处理 {{ appliedCount }} 条</span><span v-if="running" role="status">后台更新中 · {{ planSyncStore.state.job?.progress?.stage || '准备扫描' }} · {{ planSyncStore.state.job?.progress?.done || 0 }}/{{ planSyncStore.state.job?.progress?.total || '…' }}，可先查看上次结果</span><n-button size="small" :disabled="running || applying || deletingLocalTask" @click="start">重新扫描</n-button></div>
    <n-spin :show="loading">
      <template v-if="job?.state === 'ready'">
        <n-alert v-if="!pendingEntries.length" type="success" class="page-alert">核对完成，当前没有待处理差异。</n-alert>
        <n-tabs v-model:value="active" type="line"><n-tab-pane v-for="tab in tabs" :key="tab.key" :name="tab.key" :tab="`${tab.label}（${count(tab.key)}）`" /></n-tabs>
        <n-data-table :columns="columns" :data="rows" :row-key="rowKey" :checked-row-keys="selected" @update:checked-row-keys="value => selected = value" :pagination="{ pageSize: 10 }" :scroll-x="820" striped size="small" />
        <div class="reconciliation-actions"><n-button v-if="active === 'create'" type="primary" :loading="applying" :disabled="!available.length" @click="confirmApply(available.map(row => row.id), true)">一键新增（{{ available.length }}）</n-button><n-button v-if="active === 'update'" type="primary" :loading="applying" :disabled="!available.length" @click="confirmApply(available.map(row => row.id))">同步全部设置变化</n-button><n-button :type="active === 'delete' ? 'error' : 'primary'" :disabled="!selectedRows.length || applying || deletingLocalTask" :loading="applying" @click="handleSelected">{{ selectedActionLabel }}（{{ selectedRows.length }}）</n-button></div>
      </template>
    </n-spin>
  </n-modal>
</template>
<script setup>
import { computed, h, ref, watch } from 'vue'
import { planSyncStore } from '../stores/planSyncStore.js'
import { NAlert, NButton, NDataTable, NDropdown, NModal, NSpin, NTabPane, NTabs, useDialog, useMessage } from 'naive-ui'
import { applyPlanChanges } from '../services/scheduleReconciliationService.js'
import { formatDateTime } from '../services/dataService.js'
const props = defineProps({
  show: Boolean,
  isTaskDirty: { type: Function, default: () => false },
  resolveLocalTask: { type: Function, default: () => null },
  localTasksLoaded: Boolean,
  deletingLocalTask: Boolean,
})
const emit = defineEmits(['update:show', 'create', 'applied', 'edit-local', 'delete-local'])
const job = computed(() => planSyncStore.state.result || planSyncStore.state.job)
const localError = ref('')
const error = computed(() => localError.value || planSyncStore.state.error)
const running = computed(() => planSyncStore.state.running)
const loading = computed(() => planSyncStore.state.initializing || (running.value && !planSyncStore.state.result))
const applying = ref(false), active = ref('create'), selected = ref([])
const tabs = [{ key: 'create', label: '待新增' }, { key: 'delete', label: '待移除' }, { key: 'update', label: '设置变化' }, { key: 'error', label: '需人工处理' }, { key: 'whitelist', label: '白名单' }]
const message = useMessage(), dialog = useDialog()
const pendingEntries = computed(() => planSyncStore.entries.value.filter(row =>
  row.kind !== 'error' || !row.task_id || !props.localTasksLoaded || props.resolveLocalTask(row)))
const rows = computed(() => active.value === 'whitelist' ? planSyncStore.state.whitelist : pendingEntries.value.filter(row => row.kind === active.value))
const appliedCount = computed(() => (job.value?.entries || []).filter(row => row.applied).length)
const blocked = row => running.value || props.deletingLocalTask || !row.can_apply || row.kind === 'error' || (row.task_id && props.isTaskDirty(row.task_id))
const rowKey = row => active.value === 'whitelist' ? row.key : row.id
const selectable = row => !running.value && (active.value === 'whitelist' ? row.can_edit : active.value === 'error' ? true : !blocked(row))
const selectionDisabled = row => applying.value || props.deletingLocalTask || !selectable(row)
const available = computed(() => rows.value.filter(selectable))
const selectedRows = computed(() => available.value.filter(row => selected.value.includes(rowKey(row))))
const selectedActionLabel = computed(() => ({ create: '新增所选', update: '同步所选', delete: '移除所选', error: '重新核验所选', whitelist: '恢复所选提醒与同步' })[active.value])
const count = kind => kind === 'whitelist' ? planSyncStore.state.whitelist.length : pendingEntries.value.filter(row => row.kind === kind).length
async function changeIgnore(row, field, remove = false) {
  applying.value = true; localError.value = ''
  try {
    if (remove) await planSyncStore.restoreIgnored(row)
    else await planSyncStore.ignoreField(row, field)
    selected.value = []
    message.success(row.kind === 'create' || row.field === 'plan'
      ? remove ? '已恢复此计划的新增提醒' : '已加入共享白名单，不再提醒新增此计划'
      : remove ? '已恢复此属性的提醒与同步' : '已加入共享白名单，同步时保留本地值')
  } catch (error) { localError.value = error.message }
  finally { applying.value = false }
}
function display(value) {
  if (value && typeof value === 'object') return `${value.execute_scope === 'all' ? '全部执行' : '任选1台'} · ${(value.clients || []).map(client => client.name).join('、') || '未配置'}`
  return String(value ?? '—')
}
function renderFields(row) {
  const values = row.error || row.warning || (row.kind === 'create'
    ? '影刀存在，本地尚未绑定。点击查看并新增，或使用下方一键新增。'
    : row.fields.map(field => h('div', { key: field.field }, [h('strong', `${field.label}：`), h('span', display(field.local)), h('span', ' → '), h('span', display(field.remote))])))
  return h('div', { class: 'reconciliation-fields' }, [h('div', { class: 'reconciliation-field-values' }, values)])
}
function renderManualAction(row) {
  if (!row.task_id) return '请核对后重试'
  const task = props.resolveLocalTask(row)
  if (!task) return '正在读取本地任务'
  if (!task.can_edit) return '无修改权限'
  const dirty = props.isTaskDirty(task.id)
  const disabled = running.value || applying.value || props.deletingLocalTask || dirty
  return h('div', { class: 'reconciliation-manual-actions' }, [
    h(NButton, { size: 'tiny', type: 'primary', disabled, onClick: () => emit('edit-local', row) }, () => '修改'),
    h(NButton, { size: 'tiny', type: 'error', secondary: true, disabled, onClick: () => emit('delete-local', row) }, () => '删除'),
    dirty ? h('small', '请先处理当前任务的草稿') : null,
  ])
}
function renderAction(row) {
  if (row.kind === 'error') return renderManualAction(row)
  const action = blocked(row) ? h('span', running.value ? '更新结果后可同步' : row.can_apply ? '另有待保存草稿，先处理草稿' : '无修改权限')
    : h(NButton, { size: 'tiny', type: row.kind === 'delete' ? 'error' : 'primary', disabled: applying.value,
      onClick: () => row.kind === 'create' ? emit('create', { snapshot_id: job.value.id, entry: row }) : confirmApply([row.id]) },
    () => row.kind === 'create' ? '查看并新增' : row.kind === 'delete' ? '确认移除' : '同步此任务')
  return h('div', { class: 'reconciliation-row-actions' }, [action,
    row.kind === 'create' && row.can_apply ? h(NButton, { size: 'tiny', text: true, class: 'reconciliation-ignore', disabled: running.value || applying.value,
      onClick: () => changeIgnore(row, { field: 'plan' }) }, () => '加入白名单') : row.kind === 'update' && row.can_apply ? h(NDropdown, {
      trigger: 'click', placement: 'bottom-end', disabled: running.value || applying.value,
      options: row.fields.map(field => ({ key: field.field, label: `忽略${field.label}` })),
      onSelect: key => changeIgnore(row, row.fields.find(field => field.field === key)),
    }, { default: () => h(NButton, { size: 'tiny', text: true, class: 'reconciliation-ignore', disabled: running.value || applying.value }, () => '忽略此属性') }) : null,
  ])
}
const columns = computed(() => active.value === 'whitelist' ? [
  { type: 'selection', disabled: selectionDisabled },
  { title: '任务 / 影刀计划', key: 'name', render: row => h('div', { class: 'reconciliation-identity' }, [h('strong', row.name), h('small', row.schedule_uuid)]) },
  { title: '已忽略项目', key: 'label' },
  { title: '操作', key: 'action', render: row => row.can_edit ? h(NButton, { size: 'tiny', disabled: applying.value, onClick: () => changeIgnore(row, null, true) }, () => row.field === 'plan' ? '恢复新增提醒' : '恢复提醒与同步') : row.field === 'plan' ? '由加入人或管理员管理' : '由任务所有者或管理员管理' },
] : [
  { type: 'selection', disabled: selectionDisabled },
  { title: '任务 / 影刀计划', key: 'name', width: 230, render: row => h('div', { class: 'reconciliation-identity' }, [h('strong', row.name), h('small', row.schedule_uuid), h('small', `${row.owner?.display_name || '新增归当前用户'}${row.enabled === false ? ' · 已停用' : ''}`)]) },
  { title: '差异（本地 → 影刀）', key: 'fields', minWidth: 370, render: renderFields },
  { title: '操作', key: 'action', width: 160, render: renderAction },
])
watch(active, () => { selected.value = [] })
watch(available, items => {
  const allowed = new Set(items.map(rowKey))
  selected.value = selected.value.filter(key => allowed.has(key))
})
watch(() => job.value?.id, () => { selected.value = []; localError.value = '' })
watch(() => props.show, visible => { if (visible) localError.value = '' })
async function refresh() { await planSyncStore.refreshResult() }
function start() {
  localError.value = ''; selected.value = []
  emit('update:show', false)
  void planSyncStore.scan()
}
async function handleSelected() {
  const targets = [...selectedRows.value]
  if (!targets.length) return
  if (['create', 'update', 'delete'].includes(active.value)) return confirmApply(targets.map(row => row.id), active.value === 'create')
  const snapshotId = job.value.id
  const restore = active.value === 'whitelist'
  dialog.warning({ title: selectedActionLabel.value, content: restore
    ? `将恢复所选 ${targets.length} 项属性的差异提醒与同步。后续确认同步时，这些属性会重新按影刀配置更新。`
    : `仅重新读取所选 ${targets.length} 个计划并核验差异，不运行影刀任务，也不修改本地任务。`,
    positiveText: '确认执行', negativeText: '取消', onPositiveClick: async () => {
      applying.value = true; localError.value = ''
      try {
        if (restore) await planSyncStore.restoreIgnoredMany(targets)
        else await planSyncStore.recheckEntries(snapshotId, targets.map(row => row.id))
        selected.value = []
        message.success(restore ? '已恢复所选属性的提醒与同步' : '已重新核验所选计划')
      } catch (error) { localError.value = error.message }
      finally { applying.value = false }
    },
  })
}
function confirmApply(ids, bulkCreate = false) {
  const entries = pendingEntries.value.filter(row => ids.includes(row.id))
  if (!entries.length || entries.some(blocked)) return
  const removals = entries.filter(row => row.kind === 'delete').length
  const snapshotId = job.value.id
  dialog.warning({ title: bulkCreate ? '确认批量新增' : '确认更新本地任务', content: bulkCreate
    ? `将新增本次选择的 ${entries.length} 个计划（包含其他分页中的勾选）。名称、机器人、标签和开始时间从影刀读取，耗时按最近10次无重试、无异常成功记录的最大耗时向上取整到分钟；无有效记录时使用1分钟。只新增本地任务，不修改或运行影刀计划。`
    : `将同步 ${entries.length - removals} 条设置、软删除 ${removals} 条本地任务。${removals ? '移除项可能是权限变化导致不可见，请先在影刀控制台核对。' : ''}本次确认后写入数据库，操作保留历史。`, positiveText: '确认执行', negativeText: '取消', onPositiveClick: async () => {
    applying.value = true; localError.value = ''
    try {
      const result = bulkCreate ? await applyPlanChanges(snapshotId, ids, undefined, { bulkCreate: true }) : await applyPlanChanges(snapshotId, ids)
      selected.value = []
      message.success(result.message || '同步完成')
      emit('applied', result)
      await refresh()
    } catch (err) { localError.value = err.message }
    finally { applying.value = false }
  } })
}
watch(() => [props.show, running.value, job.value?.id, error.value], () => {
  if (props.show && !loading.value) planSyncStore.markRead()
}, { immediate: true })

defineExpose({ refresh })
</script>
<style>
.reconciliation-modal.n-card { width: min(1100px, 94vw); display: flex; flex-direction: column; max-height: calc(100dvh - 32px); overflow: hidden; }
.reconciliation-modal > .n-card-content { min-height: 0; overflow-y: auto; }
.reconciliation-toolbar, .reconciliation-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin: 14px 0; }
.reconciliation-toolbar { font-size: 12px; color: var(--muted); }
.reconciliation-actions { justify-content: flex-end; }
.reconciliation-identity { display: grid; gap: 5px; overflow-wrap: anywhere; }
.reconciliation-identity small { color: var(--muted); }
.reconciliation-fields { display: grid; gap: 8px; font-size: 12px; overflow-wrap: anywhere; }
.reconciliation-field-values { display: grid; gap: 8px; }
.reconciliation-row-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.reconciliation-manual-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.reconciliation-row-actions .reconciliation-ignore { color: var(--muted); font-weight: 400; }
</style>
