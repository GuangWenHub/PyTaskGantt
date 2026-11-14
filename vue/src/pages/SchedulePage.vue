<template>
  <AppShell>
    <template #header-meta>
      <span class="header-sync-cutoff header-run-status" role="status">{{ todayRunStatusText }}</span>
    </template>

    <n-alert v-if="store.state.error" type="error" :show-icon="true" class="page-alert">
      {{ store.state.error }}
    </n-alert>
    <n-alert v-if="store.hasPreviews?.value" type="warning" class="page-alert">存在未保存的预览调整，刷新会清除这些预览；已保存到本地数据库的任务和修改会保留。</n-alert>

    <n-spin :show="store.state.loading">
      <div class="schedule-layout" :style="{ '--schedule-main-height': mainHeight ? `${mainHeight}px` : 'auto' }">
        <div ref="mainElement" class="schedule-main">
          <GanttChart
            :auto-scroll="timelineAutoScroll"
            :tasks="projectedTasks"
            :show-run-status="showRunStatus"
            :run-status="todayRunStatus.data.value"
            :show-task-names="showTaskNames"
            :show-reference-lines="showReferenceLines"
            :show-current-time-line="showCurrentTimeLine"
            @manage-hidden="hiddenListVisible = true"
            @task-click="handleTaskClick"
            @task-update="handleGanttUpdate"
          />
          <TaskList
            preview-only
            :tasks="projectedTasks"
            :can-recover="Boolean(auth.user?.is_admin)"
            @edit="openEdit"
            @delete="confirmDelete"
            @history="openHistory"
            @run="confirmRun"
            @sync="syncOne"
            @rebind="openRebind"
            @transfer="openTransfer"
            @recover="openRecovery"
          />
        </div>
        <aside class="schedule-sidebar">
          <FilterPanel
            preview-only
            v-model:search-term="searchTerm"
            v-model:selected-bots="selectedBots"
            v-model:selected-owners="selectedOwners"
            v-model:sort-by="sortBy"
            :all-bots="allBots"
            :all-owners="allOwners"
            :filtered-count="filteredTasks.length"
            :total-count="store.tasks.value.length"
            :has-unsaved="store.hasUnsaved.value"
            :mutation-count="store.mutationList.value.length"
            :saving="store.state.saving"
            @refresh="confirmRefresh"
            @import="handleImport"
            @export="handleExport"
            @create="openCreate"
            :sync-unread="planSyncStore.state.unread"
            :sync-running="planSyncStore.state.running"
            @reconcile="handleReconcile"
          />
          <TaskHistoryCard
            :users="users"
            :tasks="historyTasks"
            :visible-task-ids="historyTaskIds"
            :refresh-key="store.state.serverTime"
            :is-task-dirty="historyTaskHasDraft"
            @restored="handleHistoryRestored"
          />
        </aside>
      </div>
    </n-spin>

    <TaskEditor
      :preview-only="!syncCreateContext"
      :persisting="Boolean(syncCreateContext)"
      allow-local-save
      :saving="syncCreating"
      v-model:show="editorVisible"
      :mode="editorMode"
      :task="editingTask"
      :all-bots="allBots"
      :all-tags="allTags"
      :reserved-schedule-uuids="reservedScheduleUuids"
      @submit="handleEditorSubmit"
      @save-local="handleEditorSaveLocal"
      @delete="handleEditorDelete"
      @hidden="handleTaskHidden"
      @preview-change="editorHasPreviewChanges = true"
    />
    <ScheduleReconciliationDialog ref="reconciliationRef" v-model:show="reconciliationVisible" :is-task-dirty="historyTaskHasDraft" @create="openSyncCreate" @applied="refreshAfterPlanSync" />
    <n-modal v-model:show="rebindVisible" preset="card" title="换绑影刀计划" class="responsive-modal compact-modal">
      <p class="dialog-description">任务所有者不会改变；新绑定只接收绑定时间之后的执行记录。</p>
      <SchedulePicker
        v-model="rebindScheduleUuid"
        :selected-name="actionTask?.schedule_name || ''"
        :reserved-uuids="reservedScheduleUuids"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="rebindVisible = false">取消</n-button>
          <n-button type="primary" :disabled="!rebindScheduleUuid || rebindScheduleUuid === actionTask?.schedule_uuid" :loading="actionLoading" @click="confirmRebind">确认换绑</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="transferVisible" preset="card" title="转交任务所有权" class="responsive-modal compact-modal">
      <p class="dialog-description">仅明确转交会改变任务所有者；计划绑定和执行历史保持不变。</p>
      <n-select v-model:value="targetUserId" :options="transferUserOptions" filterable placeholder="选择接收用户" />
      <template #footer>
        <n-space justify="end">
          <n-button @click="transferVisible = false">取消</n-button>
          <n-button type="warning" :disabled="!targetUserId" :loading="actionLoading" @click="confirmTransfer">确认转交</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="recoveryVisible" preset="card" title="分配并绑定历史任务" class="responsive-modal compact-modal">
      <n-alert type="warning" :show-icon="true" class="page-alert">
        绑定从服务器当前时间生效，恢复前的执行记录不会移动到新绑定。
      </n-alert>
      <p class="dialog-description">
        任务：{{ actionTask?.task }}（ID {{ actionTask?.id }}） · 当前版本 {{ actionTask?.version }}
      </p>
      <n-select v-model:value="recoveryOwnerUserId" :options="recoveryUserOptions" filterable placeholder="选择目标用户" />
      <div style="height: 12px"></div>
      <SchedulePicker
        v-model="recoveryScheduleUuid"
        :selected-name="actionTask?.schedule_name || ''"
        :reserved-uuids="reservedScheduleUuids"
        :include-bound="true"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="recoveryVisible = false">取消</n-button>
          <n-button type="primary" :disabled="!recoveryOwnerUserId || !recoveryScheduleUuid" :loading="actionLoading" @click="confirmRecovery">确认分配并绑定</n-button>
        </n-space>
      </template>
    </n-modal>
    <ExecutionHistoryDialog v-model:show="historyVisible" :task="historyTask" />
    <HiddenTasksDialog :auto-scroll="timelineAutoScroll" @update:auto-scroll="saveTimelineAutoScroll" :show-reference-lines="showReferenceLines" @update:show-reference-lines="saveReferenceLinesPreference" :show-current-time-line="showCurrentTimeLine" @update:show-current-time-line="saveCurrentTimeLinePreference" :show-hidden-tasks="showHiddenTasks" @update:show-hidden-tasks="saveHiddenTaskPreference" :show-run-status="showRunStatus" @update:show-run-status="saveRunStatusPreference" :show-task-names="showTaskNames" @update:show-task-names="saveTaskNamePreference" v-model:show="hiddenListVisible" :tasks="store.tasks.value" :saving="hiddenListSaving" @save="saveHiddenList" />
  </AppShell>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NModal, NSelect, NSpace, NSpin, useDialog, useMessage } from 'naive-ui'
import AppShell from '../components/AppShell.vue'
import ExecutionHistoryDialog from '../components/ExecutionHistoryDialog.vue'
import FilterPanel from '../components/FilterPanel.vue'
import HiddenTasksDialog from '../components/HiddenTasksDialog.vue'
import GanttChart from '../components/GanttChart.vue'
import SchedulePicker from '../components/SchedulePicker.vue'
import TaskEditor from '../components/TaskEditor.vue'
import TaskList from '../components/TaskList.vue'
import TaskHistoryCard from '../components/TaskHistoryCard.vue'
import ScheduleReconciliationDialog from '../components/ScheduleReconciliationDialog.vue'
import { applyPlanChanges } from '../services/scheduleReconciliationService.js'
import { planSyncStore } from '../stores/planSyncStore.js'
import { auth } from '../services/authService.js'
import { filterTasks } from '../services/dataService.js'
import { candidateNames, projectSharedTasks, sourceTask } from '../../shared/scheduleDispatch.mjs'
import { useRunStatusPreference, useTodayRunStatus, formatTodayRunStatus, formatDisabledRunStatus } from '../services/taskRunStatus.js'
import { useTimelineAutoScrollPreference, useTimelineNamePreference, useCurrentTimeLinePreference, useReferenceLinesPreference } from '../services/timelineNamePreference.js'
import { useMachineColorPreference, applyMachineColors } from '../services/machineColorPreference.js'
import { useHiddenTaskPreference } from '../services/hiddenTaskPreference.js'
import {
  exportTasks,
  getUsers,
  setTaskVisibility,
  saveTaskMutations,
  importTasks,
  rebindTask,
  recoverTask,
  runTask,
  syncTask,
  transferTask,
} from '../services/taskService.js'
import { scheduleTaskStore as store, myTaskStore, hasAnyTaskSaveInProgress } from '../stores/taskDraftStore.js'

function historyTaskHasDraft(id) {
  return hasAnyTaskSaveInProgress() || store.isDirty(id) || myTaskStore.isDirty(id)
}

async function handleTaskHidden() {
  try { await store.load({ preserveDraft: true, silent: true }) }
  catch (error) { message.error(`任务已隐藏，但页面刷新失败：${error.message}`) }
}

async function handleHistoryRestored() {
  try {
    await Promise.all([
      store.load({ preserveDraft: true, silent: true }),
      ...(myTaskStore.state.loaded ? [myTaskStore.load({ preserveDraft: true, silent: true })] : []),
    ])
  } catch (error) { message.error(`任务已还原，但刷新失败：${error.message}`) }
}

const message = useMessage()
const dialog = useDialog()
const searchTerm = ref('')
const selectedBots = ref([])
const selectedOwners = ref([])
const sortBy = ref('bot')
const { enabled: timelineAutoScroll, save: saveTimelineAutoScroll } = useTimelineAutoScrollPreference()
const { enabled: showHiddenTasks, save: saveHiddenTaskPreference } = useHiddenTaskPreference()
const { enabled: showTaskNames, save: saveTaskNamePreference } = useTimelineNamePreference()
const { enabled: showCurrentTimeLine, save: saveCurrentTimeLinePreference } = useCurrentTimeLinePreference()
const { enabled: showReferenceLines, save: saveReferenceLinesPreference } = useReferenceLinesPreference()
const { colors: customMachineColors } = useMachineColorPreference()
const hiddenListVisible = ref(false)
const hiddenListSaving = ref(false)
async function saveHiddenList(changes) {
  if (hiddenListSaving.value) return
  hiddenListSaving.value = true
  try {
    if (changes.length) await setTaskVisibility(changes)
    hiddenListVisible.value = false
    await store.load({ preserveDraft: true, silent: true })
    message.success('隐藏名单已保存')
  } catch (error) { message.error(error.message || '隐藏名单保存失败') }
  finally { hiddenListSaving.value = false }
}
const editorVisible = ref(false)
function handleReconcile() {
  if (planSyncStore.state.initializing) {
    message.info('正在读取数据库中的扫描结果，请稍候')
  } else if (planSyncStore.state.result) {
    reconciliationVisible.value = true
  } else if (planSyncStore.state.running) {
    message.info('正在后台核对影刀计划，完成后有差异会显示红点，可继续操作页面')
  } else if (planSyncStore.state.job || planSyncStore.state.error || planSyncStore.state.unread) {
    reconciliationVisible.value = true
  } else {
    void planSyncStore.scan()
    message.info('已开始后台核对，完成后有差异会显示红点')
  }
}
const reconciliationVisible = ref(false), reconciliationRef = ref(null), syncCreateContext = ref(null), syncCreating = ref(false)
const editorHasPreviewChanges = ref(false)
watch(editorVisible, visible => { editorHasPreviewChanges.value = false; if (!visible) syncCreateContext.value = null })
const editorMode = ref('create')
const editingTask = ref(null)
const historyVisible = ref(false)
const historyTask = ref(null)
const actionTask = ref(null)
const users = ref([])
const mainElement = ref(null)
const mainHeight = ref(0)
let layoutObserver
const actionLoading = ref(false)
const rebindVisible = ref(false)
const rebindScheduleUuid = ref('')
const transferVisible = ref(false)
const targetUserId = ref(null)
const recoveryVisible = ref(false)
const recoveryOwnerUserId = ref(null)
const recoveryScheduleUuid = ref('')
const refreshSeconds = Math.max(5, Number(auth.uiRefreshSeconds || 10))
let refreshTimer = null


const allBots = computed(() => [...new Set(store.tasks.value.flatMap(candidateNames).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const allTags = computed(() => [...new Set(store.tasks.value.flatMap(task => task.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const allOwners = computed(() => {
  const map = new Map()
  for (const task of store.tasks.value) {
    if (task.owner) map.set(String(task.owner.id), task.owner)
  }
  if (store.tasks.value.some(task => !task.owner)) map.set('legacy', { id: 'legacy', display_name: '历史任务' })
  return [...map.values()]
})
const filteredTasks = computed(() => filterTasks(store.tasks.value, {
  searchTerm: searchTerm.value,
  selectedBots: selectedBots.value,
  selectedOwners: selectedOwners.value,
  sortBy: sortBy.value,
  showHiddenTasks: showHiddenTasks.value,
}))
const { enabled: showRunStatus, save: saveRunStatusPreference } = useRunStatusPreference()
const todayRunStatus = useTodayRunStatus(showRunStatus, filteredTasks)
const todayRunStatusText = computed(() => showRunStatus.value ? formatTodayRunStatus(todayRunStatus.data.value, filteredTasks.value.length > 0) : formatDisabledRunStatus(planSyncStore.state.result))
const projectedTasks = computed(() => applyMachineColors(filterTasks(projectSharedTasks(filteredTasks.value), {
  selectedBots: selectedBots.value, sortBy: sortBy.value, preserveDecoration: true,
}), customMachineColors.value))
const historyTasks = computed(() => filteredTasks.value.filter(task => /^[1-9]\d*$/.test(String(task.id))))
const historyTaskIds = computed(() => historyTasks.value.map(task => String(task.id)).sort().join(','))
const reservedScheduleUuids = computed(() => store.tasks.value
  .filter(task => task.id !== editingTask.value?.id && task.id !== actionTask.value?.id)
  .map(task => task.schedule_uuid)
  .filter(Boolean))
const recoveryUserOptions = computed(() => users.value.map(user => ({
  label: user.display_name,
  value: String(user.id),
})))
const transferUserOptions = computed(() => recoveryUserOptions.value
  .filter(option => option.value !== String(actionTask.value?.owner?.id || '')))

onMounted(async () => {
  window.addEventListener('beforeunload', warnBeforeRefresh)
  if (typeof ResizeObserver !== 'undefined') {
    layoutObserver = new ResizeObserver(entries => { mainHeight.value = entries[0].contentRect.height })
    if (mainElement.value) layoutObserver.observe(mainElement.value)
  }
  try {
    await store.load({ preserveDraft: true })
  } catch (error) {
    message.error(`任务加载失败：${error.message}`)
  }
  getUsers().then(result => { users.value = result }).catch(() => {})
  refreshTimer = window.setInterval(pollTasks, refreshSeconds * 1000)
})

onBeforeUnmount(() => {
  layoutObserver?.disconnect()
  window.clearInterval(refreshTimer)
  window.removeEventListener('beforeunload', warnBeforeRefresh)
  store.discard?.()
})

const previewNotice = '未保存的预览调整会在刷新后清除；已保存到本地数据库的任务和修改会保留。'
function notifyPreview() { message.info('已应用到预览，未写入数据库；本次预览刷新后会消失。', { duration: 6000 }) }
function warnBeforeRefresh(event) {
  if (!store.hasPreviews?.value && !editorHasPreviewChanges.value) return
  event.preventDefault()
  event.returnValue = previewNotice
}

function pollTasks() {
  if (store.state.loading || store.state.saving) return
  store.load({ preserveDraft: true, silent: true }).catch(() => {})
}

function openCreate() {
  syncCreateContext.value = null
  editorMode.value = 'create'
  editingTask.value = { task: '', bot: allBots.value[0] || '', start: '09:00:00', finish: '09:30:00', tags: [], note: '' }
  editorVisible.value = true
}

function openEdit(task) {
  syncCreateContext.value = null
  task = sourceTask(task)
  if (!task.can_edit) return message.warning('该任务属于其他用户或为历史未绑定任务，仅可查看。')
  editorMode.value = 'edit'
  editingTask.value = { ...task, tags: [...(task.tags || [])] }
  editorVisible.value = true
}

function handleTaskClick(task) {
  if (!task.can_edit) return message.info(`“${task.task}”由 ${task.owner?.display_name || '历史数据'} 管理，当前为只读。`)
  openEdit(task)
}

function openHistory(task) {
  historyTask.value = task
  historyVisible.value = true
}

function ensureImmediateAction(task) {
  if (!store.isDirty(task.id)) return true
  message.warning('该任务有未保存草稿，请先保存或刷新后再执行立即操作。')
  return false
}

function openRebind(task) {
  if (!ensureImmediateAction(task)) return
  actionTask.value = task
  rebindScheduleUuid.value = task.schedule_uuid
  rebindVisible.value = true
}

function openTransfer(task) {
  if (!ensureImmediateAction(task)) return
  actionTask.value = task
  targetUserId.value = null
  transferVisible.value = true
}

function openRecovery(task) {
  if (!auth.user?.is_admin) return message.error('仅管理员可恢复历史任务')
  if (!ensureImmediateAction(task)) return
  actionTask.value = task
  recoveryOwnerUserId.value = task.owner?.id ? String(task.owner.id) : null
  recoveryScheduleUuid.value = task.schedule_uuid || ''
  recoveryVisible.value = true
}

function actionError(prefix, error) {
  const hints = {
    ADMIN_REQUIRED: '当前账号已不具备管理员权限，请刷新会话。',
    VERSION_CONFLICT: '任务版本已变化，请刷新后重试。',
    SCHEDULE_ALREADY_BOUND: '所选计划已被其他有效任务占用。',
    TASK_ALREADY_ACTIVE: '该任务已是正常有效任务，请使用转交或换绑。',
  }
  message.error(`${prefix}：${hints[error.code] || error.message}`)
}

async function syncOne(task) {
  try {
    const result = await syncTask(task.id)
    message.success(result.message || '任务同步完成')
    await store.load({ preserveDraft: true, silent: true })
    store.clearPreview?.(task.id)
  } catch (error) {
    actionError('同步失败', error)
  }
}

function confirmRun(task) {
  if (!ensureImmediateAction(task)) return
  dialog.warning({
    title: '立即执行影刀计划',
    content: `确定立即执行“${task.task}”吗？任务所有者不会因此改变。`,
    positiveText: '立即执行',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const result = await runTask(task.id)
        message.success(result.task_uuid ? `影刀已受理，执行 UUID：${result.task_uuid}` : '影刀已受理')
        await store.load({ preserveDraft: true, silent: true })
      } catch (error) {
        actionError('执行失败', error)
      }
    },
  })
}

async function confirmRebind() {
  actionLoading.value = true
  try {
    await rebindTask(actionTask.value.id, rebindScheduleUuid.value, actionTask.value.version)
    rebindVisible.value = false
    message.success('计划换绑成功')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    actionError('换绑失败', error)
  } finally {
    actionLoading.value = false
  }
}

async function confirmTransfer() {
  actionLoading.value = true
  try {
    await transferTask(actionTask.value.id, targetUserId.value, actionTask.value.version)
    transferVisible.value = false
    message.success('任务已转交')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    actionError('转交失败', error)
  } finally {
    actionLoading.value = false
  }
}

async function confirmRecovery() {
  actionLoading.value = true
  try {
    await recoverTask(
      actionTask.value.id,
      recoveryOwnerUserId.value,
      recoveryScheduleUuid.value,
      actionTask.value.version
    )
    recoveryVisible.value = false
    message.success('历史任务已完成分配和绑定')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    actionError('恢复失败', error)
  } finally {
    actionLoading.value = false
  }
}

function handleGanttUpdate({ id, start, finish }) {
  if (!store.updateTask(id, { start, finish })) message.warning('该任务不可编辑')
  else notifyPreview()
}

function openSyncCreate(context) {
  syncCreateContext.value = context
  editorMode.value = 'create'
  editingTask.value = { ...context.entry.defaults, tags: [...(context.entry.defaults.tags || [])] }
  editorVisible.value = true
}

async function refreshAfterPlanSync(result) {
  try {
    await store.load({ preserveDraft: true, silent: true })
    for (const id of result.affected_ids || []) store.clearPreview?.(id)
    if (myTaskStore.state.loaded) await myTaskStore.load({ preserveDraft: true, silent: true })
  } catch (error) { message.error(`本地同步已完成，但页面刷新失败：${error.message}`) }
}

async function handleEditorSaveLocal(form) {
  if (syncCreateContext.value) return handleEditorSubmit(form)
  if (syncCreating.value) return
  if (!form.schedule_uuid) return message.warning('保存到本地需要先绑定影刀计划')
  let mutation
  if (editorMode.value === 'edit') {
    const id = String(form.id), original = store.state.savedTasks?.[id] || store.tasks.value.find(task => String(task.id) === id)
    if (!/^[1-9]\d*$/.test(id) || !original?.can_edit) return message.warning('当前任务仅支持预览或没有保存权限')
    if (original.schedule_uuid !== form.schedule_uuid) return message.warning('任务绑定已变化，请重新打开编辑窗口')
    if (form._local_preview_fields?.cron && (form.schedule_cron_expression || '') !== (original.schedule_cron_expression || '')) return message.warning('循环规则当前仅支持预览，请恢复原规则后再保存其他修改')
    const dispatch = value => JSON.stringify([value?.execute_scope || '', value?.client_scope || '', (value?.clients || []).map(client => client.id).sort()])
    if (form._local_preview_fields?.dispatch && Math.max(original.schedule_dispatch?.clients?.length || 0, form.schedule_dispatch?.clients?.length || 0) > 1 && dispatch(form.schedule_dispatch) !== dispatch(original.schedule_dispatch)) return message.warning('多机候选列表当前仅支持预览，请恢复候选列表后再保存其他修改')
    const fields = ['task', 'start', 'finish', 'bot', 'tags', 'note', 'timing_mode', 'expected_duration_seconds']
    const changes = Object.fromEntries(fields.filter(field => JSON.stringify(form[field]) !== JSON.stringify(original[field])).map(field => [field, form[field]]))
    if (!Object.keys(changes).length) return message.info('没有需要保存到本地的修改')
    mutation = { type: 'update', id, version: form.version, changes }
  } else {
    const fields = ['task', 'start', 'finish', 'bot', 'tags', 'note', 'schedule_uuid', 'timing_mode', 'expected_duration_seconds']
    mutation = { type: 'create', temp_id: `local:${Date.now()}:${Math.random().toString(36).slice(2)}`, ...Object.fromEntries(fields.map(field => [field, form[field]])) }
  }
  syncCreating.value = true
  let result
  try {
    result = await saveTaskMutations([mutation])
    editorVisible.value = false
    message.success('任务已保存到本地数据库，刷新后仍会保留')
  } catch (error) { message.error(`保存失败：${error.message}`) }
  finally { syncCreating.value = false }
  if (result) await refreshAfterPlanSync({ ...result, affected_ids: mutation.type === 'update' ? [mutation.id] : Object.values(result.id_map || {}) })
}

async function handleEditorSubmit(form) {
  if (syncCreateContext.value) {
    if (syncCreating.value) return
    syncCreating.value = true
    try {
      const context = syncCreateContext.value
      const result = await applyPlanChanges(context.snapshot_id, [context.entry.id], {
        task: form.task, tags: form.tags, note: form.note, expected_duration_seconds: form.expected_duration_seconds,
      })
      editorVisible.value = false
      message.success(`${result.message || '任务已新增到本地数据库'}，刷新后仍会保留`)
      await refreshAfterPlanSync(result)
      await reconciliationRef.value?.refresh()
    } catch (error) { message.error(`新增失败：${error.message}`) }
    finally { syncCreating.value = false }
    return
  }
  if (editorMode.value === 'create') store.addTask(form)
  else store.updateTask(form.id, form)
  editorVisible.value = false
  notifyPreview()
}

function handleEditorDelete(id) {
  store.deleteTask(id)
  editorVisible.value = false
  notifyPreview()
}

function confirmDelete(task) {
  dialog.warning({
    title: '确认删除',
    content: `仅在预览中隐藏“${task.task}”，刷新后恢复。${previewNotice}`,
    positiveText: '从预览移除', negativeText: '取消',
    onPositiveClick: () => { store.deleteTask(task.id); notifyPreview() },
  })
}

function confirmRefresh() {
  if (!store.hasPreviews?.value && !editorHasPreviewChanges.value) return store.load({ preserveDraft: false }).then(() => message.success('数据已刷新')).catch(error => message.error(error.message))
  dialog.warning({
    title: '清除预览调整？',
    content: '刷新将清除未保存的预览调整，重新读取本地数据库；已保存到本地的任务和修改会保留。',
    positiveText: '清除并刷新', negativeText: '取消',
    onPositiveClick: () => store.load({ preserveDraft: false }).then(() => { editorVisible.value = false; editorHasPreviewChanges.value = false; message.success('已清除预览并刷新') }).catch(error => message.error(error.message)),
  })
}

async function handleImport(file) {
  try {
    const content = await file.text()
    const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv'
    const result = await importTasks(content, format)
    await store.load({ preserveDraft: true, silent: true })
    message.success(result.message || '导入完成')
  } catch (error) {
    message.error(`导入失败：${error.message}`)
  }
}

async function handleExport(format) {
  try {
    await exportTasks(format)
    message.success(`已导出 ${format.toUpperCase()} 文件`)
  } catch (error) {
    message.error(`导出失败：${error.message}`)
  }
}
</script>
