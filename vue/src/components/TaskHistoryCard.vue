<template>
  <n-card title="操作记录" size="small" :bordered="true" class="task-history-card" :style="{ '--history-min-row': `${minimumRowHeight}px` }">
    <template #header-extra>
      <n-button size="tiny" quaternary :loading="loading" @click="load">刷新记录</n-button>
    </template>
    <div class="history-retention">每个任务保留最近 50 条 · 共 {{ retainedCount }} 条留存记录</div>
    <div class="history-filters">
      <n-select v-model:value="actorId" :options="actorOptions" clearable filterable size="small" placeholder="全部操作人" />
      <n-select v-model:value="taskId" :options="taskOptions" clearable filterable size="small" placeholder="全部任务" />
    </div>
    <div ref="listElement" class="history-list" :style="{ '--history-row-max': `${rowMaxHeight}px` }">
    <n-alert v-if="error" type="error" :show-icon="true" class="history-error">{{ error }}</n-alert>
    <n-empty v-else-if="!loading && !records.length" size="small" description="暂无操作记录" />
    <div v-for="section in [{ key: 'visible', items: records }, { key: 'measure', items: allRecords }]" :key="section.key" :class="section.key === 'measure' ? 'history-measure' : 'history-rows'" :aria-hidden="section.key === 'measure' ? 'true' : undefined" :inert="section.key === 'measure' ? true : undefined">
    <div v-for="record in section.items" :key="record.id" class="history-entry" @click="detailRecord = record">
      <div class="history-entry-meta">
        <strong :title="record.actor_name">{{ record.actor_name }}</strong>
        <time>{{ formatDateTime(record.created_at) }}</time>
      </div>
      <div class="history-entry-title" :title="record.task_name">{{ historyAction(record) }} · {{ record.task_name }}</div>
      <div v-if="record.snapshot_complete" class="history-hint">{{ !record.before ? '新增任务' : `变更 ${historyChanges(record.before, record.after).length} 项` }}</div>
      <div v-else class="history-hint">{{ record.action === 'run_now' ? '执行操作保留记录，不支持还原运行' : '旧记录缺少完整快照，仅供查看和备注' }}</div>
      <div v-if="record.annotation" class="history-annotation" :title="record.annotation" @click="detailRecord = record">备注：{{ record.annotation }}</div>
      <div class="history-entry-actions">
        <n-button size="tiny" quaternary type="primary" @click.stop="detailRecord = record">查看详情</n-button>
        <n-button v-if="record.can_annotate" size="tiny" quaternary type="primary" :disabled="busy" @click.stop="openAnnotation(record)">{{ record.annotation ? '编辑备注' : '添加备注' }}</n-button>
        <span v-if="record.reverted" class="history-hint">已由 {{ record.reverted_by_name || '用户' }} 还原</span>
        <n-button v-else-if="record.can_restore" size="tiny" quaternary type="warning" :disabled="busy || isTaskDirty(record.task_id)" :loading="previewingId === record.id" @click.stop="openRestore(record)">还原</n-button>
      </div>
    </div>
    </div>
    </div>
    <div class="history-pagination">
      <n-pagination simple :page="page" :page-count="pages.length || 1" size="small" :disabled="loading" @update:page="changePage" />
    </div>

    <n-modal :show="Boolean(detailRecord)" preset="card" title="操作记录详情" class="responsive-modal" @update:show="value => { if (!value) detailRecord = null }">
      <div v-if="detailRecord" class="history-detail-body">
        <dl class="history-detail-meta">
          <dt>任务</dt><dd>{{ detailRecord.task_name }}</dd>
          <dt>操作人</dt><dd>{{ detailRecord.actor_name }}</dd>
          <dt>操作时间</dt><dd>{{ formatDateTime(detailRecord.created_at) }}</dd>
          <dt>操作</dt><dd>{{ historyAction(detailRecord) }}</dd>
        </dl>
        <p v-if="!detailRecord.snapshot_complete" class="history-hint">{{ detailRecord.action === 'run_now' ? '执行操作保留记录，不支持还原运行' : '旧记录缺少完整快照，仅供查看和备注' }}</p>
        <div v-if="!detailRecord.before && detailRecord.snapshot_complete">新增任务，操作前不存在</div>
        <div v-for="field in !detailRecord.before && detailRecord.after ? Object.keys(HISTORY_FIELDS) : []" :key="field" class="history-change">
          <span>{{ HISTORY_FIELDS[field] }}</span>
          <div>{{ historyValue(field, detailRecord.after[field], ownerNames) }}</div>
        </div>
        <div v-for="field in historyChanges(detailRecord.before, detailRecord.after)" :key="field" class="history-change">
          <span>{{ HISTORY_FIELDS[field] }}</span>
          <div>{{ historyValue(field, detailRecord.before[field], ownerNames) }} → {{ historyValue(field, detailRecord.after[field], ownerNames) }}</div>
        </div>
        <p v-if="detailRecord.annotation" class="history-full-annotation">备注：{{ detailRecord.annotation }}</p>
        <p v-if="detailRecord.reverted" class="history-hint">已由 {{ detailRecord.reverted_by_name || '用户' }} 还原</p>
      </div>
    </n-modal>

    <n-modal v-model:show="annotationVisible" preset="card" title="操作记录备注" class="responsive-modal compact-modal" :mask-closable="!saving" :closable="!saving">
      <p class="dialog-description">{{ selectedAnnotation?.task_name }} · {{ selectedAnnotation?.actor_name }}</p>
      <n-input v-model:value="annotation" type="textarea" maxlength="1000" show-count placeholder="例如：7:30 前没数据" :disabled="saving" />
      <n-alert v-if="annotationError" type="error" class="history-error">{{ annotationError }}</n-alert>
      <template #footer><n-space justify="end">
        <n-button :disabled="saving" @click="annotationVisible = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="saveAnnotation">保存备注</n-button>
      </n-space></template>
    </n-modal>

    <n-modal v-model:show="restoreVisible" preset="card" title="还原单个任务" class="responsive-modal" :mask-closable="!restoring" :closable="!restoring">
      <n-alert type="warning" :show-icon="true">{{ preview?.visibility_only ? '仅还原这条记录的隐藏状态，不改变任务名称、时间、机器、绑定等配置。' : '会覆盖选中记录之后对本任务的修改。其他任务和已经发生的执行历史保持不变。' }}</n-alert>
      <p v-if="preview?.target.deleted" class="dialog-description">还原后该任务将处于删除状态，并释放计划绑定；影刀计划本身不会被删除。</p>
      <p class="dialog-description">{{ selectedRestore?.task_name }} · {{ selectedRestore?.actor_name }} · {{ formatDateTime(selectedRestore?.created_at) }}</p>
      <div class="history-restore-comparison">
        <div class="history-comparison-head"><span>字段</span><span>当前状态</span><span>还原后</span></div>
        <div v-for="field in preview?.changes || []" :key="field" class="history-comparison-row">
          <span>{{ HISTORY_FIELDS[field] }}</span>
          <span>{{ historyValue(field, preview.current[field], preview.owners) }}</span>
          <span>{{ historyValue(field, preview.target[field], preview.owners) }}</span>
        </div>
      </div>
      <p v-if="preview && !preview.changes.length" class="history-hint">任务配置已与目标状态一致，无需还原。</p>
      <n-alert v-if="restoreError" type="error" class="history-error">{{ restoreError }}</n-alert>
      <template #footer><n-space justify="end">
        <n-button :disabled="restoring" @click="restoreVisible = false">取消</n-button>
        <n-button type="warning" :disabled="!preview?.changes.length || isTaskDirty(preview.task_id)" :loading="restoring" @click="confirmRestore">确认还原此任务</n-button>
      </n-space></template>
    </n-modal>
  </n-card>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NModal, NPagination, NSelect, NSpace, useMessage } from 'naive-ui'
import { formatDateTime } from '../services/dataService.js'
import { historyAction, HISTORY_FIELDS, getTaskHistory, historyChanges, historyValue, previewHistoryRestore, restoreHistory, saveHistoryAnnotation } from '../services/taskHistoryService.js'
import { fitHistoryPages } from '../services/historyPagination.js'

const props = defineProps({
  users: { type: Array, default: () => [] }, tasks: { type: Array, default: () => [] },
  refreshKey: { default: null }, isTaskDirty: { type: Function, default: () => false },
  visibleTaskIds: { type: String, default: null },
})
const emit = defineEmits(['restored'])
const message = useMessage()
const allRecords = ref([])
const pages = ref([])
const records = computed(() => pages.value[page.value - 1] || [])
const actorId = ref(null)
const taskId = ref(null)
const retainedCount = ref(0)
const loading = ref(false)
const page = ref(1)
const listElement = ref(null)
const rowMaxHeight = ref(240)
const minimumRowHeight = ref(128)
const detailRecord = ref(null)
let sizeObserver
const error = ref('')
const annotationVisible = ref(false)
const selectedAnnotation = ref(null)
const annotation = ref('')
const annotationError = ref('')
const saving = ref(false)
const selectedRestore = ref(null)
const restoreVisible = ref(false)
const preview = ref(null)
const restoreError = ref('')
const previewingId = ref(null)
const restoring = ref(false)
const busy = computed(() => saving.value || restoring.value || previewingId.value != null)
const ownerNames = computed(() => Object.fromEntries(props.users.map(user => [String(user.id), user.display_name])))
const actorOptions = computed(() => {
  const options = new Map(props.users.map(user => [String(user.id), { label: user.display_name, value: String(user.id) }]))
  for (const record of records.value) if (record.actor_user_id && !options.has(record.actor_user_id)) {
    options.set(record.actor_user_id, { label: record.actor_name, value: record.actor_user_id })
  }
  return [...options.values()]
})
const taskOptions = computed(() => {
  const options = new Map(props.tasks.filter(task => /^[1-9]\d*$/.test(String(task.id))).map(task => [String(task.id), { label: task.task, value: String(task.id) }]))
  for (const record of records.value) if (!options.has(record.task_id)) options.set(record.task_id, { label: record.task_name, value: record.task_id })
  return [...options.values()]
})
let requestId = 0
let generation = 0

async function measurePages() {
  await nextTick()
  if (!listElement.value) return
  const height = listElement.value.clientHeight
  const rows = [...listElement.value.querySelectorAll('.history-measure .history-entry')]
  const heights = rows.map(row => row.getBoundingClientRect().height)
  minimumRowHeight.value = heights.reduce((largest, height) => Math.max(largest, height), 128)
  // Non-layout environments (unit tests) cannot supply usable measurements.
  pages.value = height > 0 && heights.every(value => value > 0)
    ? fitHistoryPages(allRecords.value, heights, height)
    : (allRecords.value.length ? [allRecords.value] : [])
  page.value = Math.min(page.value, Math.max(1, pages.value.length))
  updateRowLimit()
}

function updateRowLimit() {
  // Sparse final pages still fill the card. The upper bound grows only when
  // fewer rows remain than would normally fill the available height.
  rowMaxHeight.value = Math.max(240, minimumRowHeight.value, (listElement.value?.clientHeight || 0) / Math.max(1, records.value.length))
}

async function load() {
  const request = ++requestId
  if (props.visibleTaskIds === '') {
    allRecords.value = []; pages.value = []; retainedCount.value = 0; loading.value = false; error.value = ''; return
  }
  loading.value = true
  error.value = ''
  try {
    const filters = { actor_id: actorId.value, task_id: taskId.value, task_ids: props.visibleTaskIds, limit: 50 }
    const data = await getTaskHistory({ ...filters, page: 1 })
    if (request !== requestId) return
    const result = [...data.records]
    // Fetch retained records in bounded batches. All page boundaries are measured
    // from this same ordered result, rather than estimating counts from row height.
    const count = data.has_more ? Math.ceil(data.retained_count / 50) : 1
    for (let first = 2; first <= count; first += 4) {
      const batch = await Promise.all(Array.from({ length: Math.min(4, count - first + 1) }, (_, index) => getTaskHistory({ ...filters, page: first + index })))
      if (request !== requestId) return
      result.push(...batch.flatMap(item => item.records))
    }
    allRecords.value = [...new Map(result.map(record => [record.id, record])).values()]
    retainedCount.value = data.retained_count
    await measurePages()
  } catch (e) {
    if (request === requestId) error.value = `操作记录加载失败：${e.message}`
  } finally { if (request === requestId) loading.value = false }
}

function openAnnotation(record) {
  if (busy.value) return
  selectedAnnotation.value = { ...record }
  annotation.value = record.annotation
  annotationError.value = ''
  annotationVisible.value = true
}
async function saveAnnotation() {
  if (saving.value) return
  const currentGeneration = generation
  saving.value = true
  try {
    const record = selectedAnnotation.value
    await saveHistoryAnnotation(record.id, annotation.value, record.annotation_version)
    if (generation !== currentGeneration) return
    annotationVisible.value = false
    message.success('记录备注已保存')
    await load()
  } catch (e) { if (generation === currentGeneration) annotationError.value = e.message }
  finally { if (generation === currentGeneration) saving.value = false }
}
async function openRestore(record) {
  if (busy.value) return
  if (props.isTaskDirty(record.task_id)) return message.warning('请先保存或丢弃该任务的草稿')
  const currentGeneration = generation
  previewingId.value = record.id
  try {
    const result = await previewHistoryRestore(record.id)
    if (generation !== currentGeneration) return
    selectedRestore.value = record
    preview.value = result
    restoreError.value = ''
    restoreVisible.value = true
  } catch (e) { if (generation === currentGeneration) message.error(`无法还原：${e.message}`) }
  finally { if (generation === currentGeneration) previewingId.value = null }
}
async function confirmRestore() {
  if (restoring.value) return
  if (props.isTaskDirty(preview.value.task_id)) return message.warning('请先保存或丢弃该任务的草稿')
  const currentGeneration = generation
  restoring.value = true
  try {
    await restoreHistory(selectedRestore.value.id, preview.value.task_version)
    if (generation !== currentGeneration) return
    restoreVisible.value = false
    message.success('任务已还原')
    emit('restored')
    await load()
  } catch (e) { if (generation === currentGeneration) restoreError.value = `${e.message}；请关闭弹窗后重新预览。` }
  finally { if (generation === currentGeneration) restoring.value = false }
}

function changePage(value) { page.value = value; updateRowLimit() }
watch([actorId, taskId, () => props.visibleTaskIds], () => { page.value = 1; allRecords.value = []; pages.value = []; load() }, { immediate: true })
watch(() => props.refreshKey, () => { if (!loading.value && !busy.value) load() })
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    sizeObserver = new ResizeObserver(measurePages)
    if (listElement.value) sizeObserver.observe(listElement.value)
  }
  measurePages()
})
onBeforeUnmount(() => { sizeObserver?.disconnect(); generation += 1; requestId += 1 })
</script>

<style scoped>
.task-history-card { height: 100%; min-height: calc(var(--history-min-row, 128px) + 280px); min-width: 0; max-width: 100%; }
.task-history-card :deep(> .n-card-content) { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.task-history-card :deep(> .n-card-header) { flex-shrink: 0; flex-wrap: wrap; gap: 8px; }
.history-list { flex: 1; min-height: var(--history-min-row, 128px); min-width: 0; position: relative; }
.history-rows { height: 100%; display: flex; flex-direction: column; }
.history-rows > .history-entry { flex: 1 1 auto; max-height: var(--history-row-max); }
.history-measure { position: absolute; top: 0; left: 0; width: 100%; height: 0; overflow: hidden; visibility: hidden; pointer-events: none; contain: layout style; }
.history-pagination { display: flex; justify-content: flex-end; padding-top: 12px; min-width: 0; flex-shrink: 0; }
.history-pagination :deep(.n-pagination) { flex-wrap: wrap; max-width: 100%; }
.history-retention { flex-shrink: 0; overflow-wrap: anywhere; }
.history-filters :deep(.n-select), .history-filters :deep(.n-base-selection) { min-width: 0; width: 100%; max-width: 100%; }
.history-full-annotation { white-space: pre-wrap; overflow-wrap: anywhere; }
.history-detail-body { max-height: 65vh; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.history-detail-meta { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 8px 12px; margin: 0 0 16px; }
.history-detail-meta dt { color: var(--muted); }
.history-detail-meta dd { margin: 0; }
.history-retention, .history-hint { font-size: 12px; color: var(--muted); line-height: 1.6; }
.history-filters { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin: 12px 0; min-width: 0; flex-shrink: 0; }
.history-entry { min-height: 128px; min-width: 0; box-sizing: border-box; padding: 8px 12px; border-top: 1px solid var(--line-soft); display: flex; flex-direction: column; align-items: stretch; cursor: pointer; }
.history-entry:nth-of-type(odd) { background: var(--warm); }
.history-entry:nth-of-type(even) { background: #fff; }
.history-entry:hover { background: var(--soft); }
.history-entry-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; font-size: 12px; flex-shrink: 0; }
.history-entry-meta strong { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
.history-entry-meta time { color: var(--muted); flex-shrink: 0; }
.history-entry-title { margin: 6px 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; flex-shrink: 0; }
.history-change { padding-top: 6px; overflow-wrap: anywhere; }
.history-change > span { color: var(--muted); }
.history-annotation { background: var(--warm); border-radius: 4px; padding: 4px; margin-top: 4px; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
.history-entry-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px 8px; margin-top: 6px; flex-shrink: 0; }
.history-entry-actions :deep(.n-button) { flex-shrink: 0; }
.history-entry-actions .history-hint { min-width: 0; overflow-wrap: anywhere; }
.history-entry > .history-hint { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.history-error { margin-top: 12px; }
.history-restore-comparison { margin-top: 12px; font-size: 12px; }
.history-comparison-head, .history-comparison-row { display: grid; grid-template-columns: 80px minmax(0, 1fr) minmax(0, 1fr); gap: 12px; padding: 8px; border-bottom: 1px solid var(--line-soft); overflow-wrap: anywhere; }
.history-comparison-head { background: var(--warm); font-weight: 600; }
</style>
