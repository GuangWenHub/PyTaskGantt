<template>
  <n-modal
    :show="show"
    preset="card"
    :title="modalTitle"
    class="responsive-modal task-editor-modal"
    :mask-closable="false"
    :closable="!saving && !hiding"
    :close-on-esc="!saving && !hiding"
    :bordered="false"
    @update:show="value => $emit('update:show', value)"
  >
    <n-form ref="formRef" :model="form" :rules="rules" label-placement="top" @input.capture="notifyPreviewEdit" @change.capture="notifyPreviewEdit">
      <n-form-item v-if="mode === 'create'" :label="previewOnly ? '绑定影刀计划（预览可不选）' : '绑定影刀计划'" path="schedule_uuid">
        <SchedulePicker
          v-model="form.schedule_uuid"
          :selected-name="form.schedule_name"
          :reserved-uuids="reservedScheduleUuids"
          :disabled="persisting || saving"
          @select="selectSchedule"
        />
      </n-form-item>

      <n-form-item v-else label="当前影刀计划">
        <div class="current-binding">
          <div class="binding-identity"><code>{{ form.schedule_uuid || '未绑定，仅可只读展示' }}</code><span v-if="form.schedule_uuid">{{ form.schedule_name || '名称暂未获取' }}</span></div>
          <small v-if="form.schedule_uuid">如需更换计划，请在“我的任务”页面使用“换绑”。</small>
        </div>
      </n-form-item>

      <p class="task-mode-hint" role="status">{{ cronLoading ? '正在读取影刀计划…' : form.schedule_uuid && !metadataError ? (form.timing_mode === 'cron' ? '🔁 循环任务（自动识别）' : '常规任务（自动识别）') : '选择计划后自动识别任务类型' }}</p>
      <n-alert v-if="metadataError" type="warning" class="editor-alert">{{ metadataError }}</n-alert>

      <n-form-item label="任务名称" path="task">
        <n-input v-model:value="form.task" placeholder="例如：登录系统" maxlength="100" show-count />
      </n-form-item>

      <n-form-item :label="botLabel" path="bot">
        <n-select
          :value="selectedBots"
          :options="machineOptions"
          :disabled="!canPreviewEdit"
          :max="canPreviewEdit || hasScheduleClients ? undefined : 1"
          multiple
          placeholder="选择或输入新机器人"
          filterable
          tag
          @update:value="updateBots"
        />
        <template v-if="dispatchError" #feedback>{{ dispatchError }}</template>
      </n-form-item>

      <n-form-item label="标签">
        <n-select v-model:value="form.tags" :options="tagOptions" :render-label="renderTagLabel" placeholder="自动识别周期，也可手动修改" filterable multiple tag />
      </n-form-item>
      <section v-if="form.timing_mode === 'cron'" class="task-mode-settings task-mode-panel" aria-label="循环任务设置">
        <div class="task-mode-panel-heading"><span class="recurring-label">🔁 循环任务</span></div>
        <n-form-item label="耗时">
          <DurationPicker :value="form.expected_duration_seconds" :min="1" :max="86400" :disabled="cronLoading" @update:value="updateDuration" />
        </n-form-item>
        <n-form-item :label="previewOnly ? '循环规则（仅预览）' : '影刀循环规则（只读）'">
          <div class="cron-preview">
            <n-input v-model:value="cronExpression" :readonly="!previewOnly" aria-label="影刀循环规则" :placeholder="cronLoading ? '正在读取…' : '请先绑定有循环规则的影刀计划'" @update:value="cronEdited = true; notifyPreviewEdit()" />
            <div v-if="cronExpression">{{ cronSummary }}</div>
          </div>
        </n-form-item>
        <n-form-item v-if="cronTimes.length" label="触发时刻">
          <div class="cron-times" role="region" aria-label="全部触发时刻" tabindex="0"><span v-for="time in cronTimes" :key="time">{{ time }}</span></div>
        </n-form-item>
        <p class="task-mode-hint">规则来自影刀计划，统一展示每日时间模板。</p>
        <n-alert v-if="cronError" type="warning" class="editor-alert">{{ cronError }}</n-alert>
      </section>
      <section v-else class="task-mode-panel" aria-label="常规任务设置">
        <div class="task-time-row">
          <n-form-item class="task-time-field" label="开始时间" path="start">
            <ClockTimePicker :value="form.start" :disabled="cronLoading || persisting" label="开始时间" @edit="notifyPreviewEdit" @update:value="updateStart" />
          </n-form-item>
          <n-form-item class="task-time-duration" label="耗时" :show-feedback="false">
            <DurationPicker :value="durationSeconds" :min="1" :disabled="cronLoading || !form.start" @update:value="updateDuration" />
          </n-form-item>
          <n-form-item class="task-time-field" label="结束时间" path="finish">
            <ClockTimePicker :value="form.finish" label="结束时间" @edit="notifyPreviewEdit" @update:value="updateFinish" />
          </n-form-item>
        </div>
        <n-alert v-if="isCrossDayTask" type="info" :show-icon="true" class="editor-alert">已识别为跨天任务</n-alert>
      </section>

      <n-alert v-if="persisting && !runsLoading && !usableHistoricalDuration && !durationEdited" type="warning" class="editor-alert">{{ runsError || recentRuns?.incomplete ? '运行记录读取或核验失败，请重试，或用滑条、输入框手动确认耗时后再新增。' : '没有可用的历史耗时，请用滑条或输入框手动确认耗时后再新增。' }}</n-alert>

      <n-form-item label="备注">
        <n-input
          v-model:value="form.note"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          maxlength="2000"
          show-count
          placeholder="补充运行说明、交接信息或注意事项"
        />
      </n-form-item>
      <RecentScheduleRuns :result="recentRuns" :loading="runsLoading" :error="runsError" :bound="Boolean(form.schedule_uuid)" />
    </n-form>

    <template #footer>
      <div class="editor-footer" :class="{ 'editor-footer-edit': mode === 'edit' }">
        <div v-if="mode === 'edit'" class="editor-secondary-actions">
          <n-button type="error" ghost :disabled="hiding || saving" @click="confirmDelete">删除任务</n-button>
          <n-button v-if="canHideTask" text class="hide-task-link" :disabled="hiding || saving || task.is_hidden" @click="confirmHide">{{ task.is_hidden ? '已隐藏' : '隐藏任务' }}</n-button>
        </div>
        <span v-else></span>
        <n-space>
          <n-button :disabled="saving || hiding" @click="$emit('update:show', false)">取消</n-button>
          <n-button v-if="!persisting" :type="canSaveLocal ? 'default' : 'primary'" :disabled="saving || hiding || cronLoading || (mode === 'create' && Boolean(metadataError))" @click="onSubmit()">
            {{ previewOnly ? '应用到预览' : mode === 'create' ? '加入待保存草稿' : '保存到草稿' }}
          </n-button>
          <n-button v-if="canSaveLocal" type="primary" :loading="saving" :disabled="saving || hiding || cronLoading || Boolean(metadataError)" @click="onSubmit(true)">保存到本地</n-button>
        </n-space>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  useDialog,
  useMessage,
} from 'naive-ui'
import SchedulePicker from './SchedulePicker.vue'
import { setTaskVisibility } from '../services/taskService.js'
import RecentScheduleRuns from './RecentScheduleRuns.vue'
import DurationPicker from './DurationPicker.vue'
import ClockTimePicker from './ClockTimePicker.vue'
import { getTaskFrequencyBadge, isCrossDay, normalizeTime } from '../services/dataService.js'
import { getScheduleEditor, getScheduleRecentRuns } from '../services/yingdaoService.js'
import { elapsedBetween, suggestedFinish } from '../../shared/scheduleAutofill.mjs'
import { cronTemplateSummary, parseYingdaoCron } from '../../shared/yingdaoCron.mjs'

const props = defineProps({
  persisting: { type: Boolean, default: false },
  allowLocalSave: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  previewOnly: { type: Boolean, default: false },
  show: { type: Boolean, default: false },
  mode: { type: String, default: 'create' },
  task: { type: Object, default: () => ({}) },
  allBots: { type: Array, default: () => [] },
  allTags: { type: Array, default: () => [] },
  reservedScheduleUuids: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:show', 'submit', 'delete', 'preview-change', 'hidden', 'save-local'])
const message = useMessage()
const dialog = useDialog()
const hiding = ref(false)
const canSaveLocal = computed(() => props.allowLocalSave && Boolean(form.schedule_uuid) && (props.mode === 'create' || /^[1-9]\d*$/.test(String(form.id || ''))))
const canHideTask = computed(() => props.mode === 'edit' && /^[1-9]\d*$/.test(String(props.task?.id || '')))
function confirmHide() {
  if (!canHideTask.value || props.task.is_hidden || hiding.value || props.saving) return
  const id = String(props.task.id)
  dialog.warning({
    title: '隐藏任务',
    content: `是否隐藏任务“${props.task.task}”？可在甘特图标题栏的“设置”中移出隐藏名单，恢复显示。隐藏仅影响显示，不会保存当前弹窗中尚未应用的修改，也不影响影刀计划执行。`,
    positiveText: '确认隐藏', negativeText: '取消',
    onPositiveClick: async () => {
      if (hiding.value) return false
      hiding.value = true
      try {
        await setTaskVisibility([{ id, expected_hidden: false, is_hidden: true }])
        message.success('任务已隐藏，可在“设置”中恢复显示')
        emit('hidden', id)
        if (String(props.task?.id) === id) emit('update:show', false)
      } catch (error) { message.error(error.message || '隐藏失败，请稍后重试'); return false }
      finally { hiding.value = false }
    },
  })
}
const formRef = ref(null)
const canPreviewEdit = computed(() => props.previewOnly && (props.mode === 'edit' || !form.schedule_uuid))
const machinesEdited = ref(false)
const startEdited = ref(false)
const cronEdited = ref(false)
const durationEdited = ref(false)
const form = reactive({
  id: null,
  version: 0,
  task: '',
  bot: '',
  start: '09:00:00',
  finish: '09:30:00',
  tags: [],
  note: '',
  schedule_uuid: '',
  schedule_name: '',
  timing_mode: 'single', expected_duration_seconds: 60,
})
const cronExpression = ref('')
const cronLoading = ref(false)
const cronError = ref('')

function updateDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > (form.timing_mode === 'cron' ? 86400 : 86399)) return
  durationEdited.value = true
  form.expected_duration_seconds = seconds
  const finish = suggestedFinish(form.start, seconds)
  if (finish) form.finish = finish
  notifyPreviewEdit()
}
function updateStart(value) {
  form.start = value
  startEdited.value = true
  notifyPreviewEdit()
}
function updateFinish(value) {
  form.finish = value
  durationEdited.value = true
  const duration = elapsedBetween(form.start, value)
  if (duration !== null && duration > 0) form.expected_duration_seconds = duration
  notifyPreviewEdit()
}

let previewNotified = false
let previewToast = null
function clearPreviewNotice() { previewToast?.destroy?.(); previewToast = null }
function notifyPreviewEdit() {
  if (!props.previewOnly || previewNotified) return
  previewNotified = true
  emit('preview-change')
  previewToast = message.info?.(canSaveLocal.value ? '可选择“应用到预览”临时调整，或“保存到本地”写入数据库，保存后刷新仍会保留。' : '当前未保存到数据库；应用到预览仅用于临时调整。', { duration: 6000 })
}
const dispatchInfo = ref({})
const dispatchError = ref('')

const hasScheduleClients = computed(() => Boolean(dispatchInfo.value.clients?.length))
const selectedBots = computed(() => hasScheduleClients.value ? dispatchInfo.value.clients.map(client => client.id) : (form.bot ? [form.bot] : []))
const machineOptions = computed(() => {
  const clients = (dispatchInfo.value.clients || []).map(client => ({ label: client.name, value: client.id }))
  return [...clients, ...botOptions.value.filter(option => !clients.some(client => client.label.split('@')[0] === option.value))]
})
function updateBots(values) {
  if (!canPreviewEdit.value) return
  const clients = values.map(value => {
    const existing = dispatchInfo.value.clients?.find(client => client.id === value)
    return existing || { id: `preview:${value}`, name: String(value) }
  })
  dispatchInfo.value = { ...dispatchInfo.value, clients, execute_scope: 'any', client_scope: 'assign' }
  form.bot = clients[0]?.name.split('@')[0] || ''
  machinesEdited.value = true
  notifyPreviewEdit()
}
const botLabel = computed(() => `机器人 / Bot${hasScheduleClients.value && dispatchInfo.value.clients.length > 1 ? (dispatchInfo.value.execute_scope === 'any' ? '（共享 · 任选1台）' : dispatchInfo.value.execute_scope === 'all' ? '（全部执行）' : '') : ''}`)
const cronSummary = computed(() => cronTemplateSummary(cronExpression.value, form.expected_duration_seconds))
const cronTimes = computed(() => {
  try { return parseYingdaoCron(cronExpression.value).seconds.map(s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(s % 3600 / 60).padStart(2, '0')}`) }
  catch { return [] }
})
watch(() => [props.show, props.task], () => {
  if (!props.show) { clearPreviewNotice(); return }
  previewNotified = false
  machinesEdited.value = false
  startEdited.value = false
  cronEdited.value = false
  durationEdited.value = false
  Object.assign(form, {
    id: props.task?.id ?? null,
    version: props.task?.version || 0,
    task: props.task?.task || '',
    bot: props.task?.bot || props.allBots[0] || '',
    start: normalizeTime(props.task?.start || '09:00:00'),
    finish: normalizeTime(props.task?.finish || '09:30:00'),
    tags: [...(props.task?.tags || [])],
    note: props.task?.note || '',
    schedule_uuid: props.task?.schedule_uuid || '',
    schedule_name: props.task?.schedule_name || '',
    timing_mode: props.task?.timing_mode || 'single',
    expected_duration_seconds: props.task?.expected_duration_seconds || 60,
  })
}, { immediate: true, deep: true })

const metadataError = ref('')
const recentRuns = ref(null)
const usableHistoricalDuration = computed(() => {
  const seconds = recentRuns.value?.rounded_duration_seconds
  return Number.isInteger(seconds) && seconds > 0 && seconds <= (form.timing_mode === 'cron' ? 86400 : 86399)
})
const runsLoading = ref(false)
const runsError = ref('')
let requestId = 0

function selectSchedule(schedule) {
  form.schedule_name = schedule?.schedule_name || ''
  form.task = form.schedule_name
}

watch(() => [props.show, form.schedule_uuid], () => {
  const request = ++requestId
  recentRuns.value = null
  runsError.value = ''
  metadataError.value = ''
  cronError.value = ''
  cronLoading.value = false
  runsLoading.value = false
  dispatchInfo.value = props.task?.schedule_uuid === form.schedule_uuid ? props.task?.schedule_dispatch || {} : {}
  dispatchError.value = ''
  cronExpression.value = props.task?.schedule_uuid === form.schedule_uuid ? props.task?.schedule_cron_expression || '' : ''
  if (!props.show) return
  if (!form.schedule_uuid) {
    if (props.mode === 'create') {
      form.timing_mode = 'single'
      if (!form.start) form.start = '09:00:00'
    }
    return
  }
  const uuid = form.schedule_uuid
  const isCreate = props.mode === 'create'
  const originalName = form.task, originalTags = JSON.stringify(form.tags)
  let lastAutoFinish = form.finish, lastAutoDuration = form.expected_duration_seconds
  const current = () => request === requestId && props.show && uuid === form.schedule_uuid
  function applyDuration() {
    if (!isCreate || !current() || durationEdited.value) return
    const seconds = recentRuns.value?.rounded_duration_seconds
    if (!seconds || seconds > (form.timing_mode === 'cron' ? 86400 : 86399)) return
    if (form.expected_duration_seconds === lastAutoDuration) {
      form.expected_duration_seconds = seconds
      lastAutoDuration = seconds
    }
    const finish = suggestedFinish(form.start, seconds)
    if (finish && form.finish === lastAutoFinish) {
      form.finish = finish
      lastAutoFinish = finish
    }
  }
  cronLoading.value = true
  runsLoading.value = true
  getScheduleEditor(uuid).then(result => {
    if (!current()) return
    if (result.schedule_uuid !== uuid) throw new Error('影刀返回的计划与当前绑定不一致')
    form.schedule_name = result.schedule_name || form.schedule_name
    if (isCreate && form.task === originalName) form.task = form.schedule_name
    if (!machinesEdited.value && !(props.previewOnly && props.task?._preview_modified)) dispatchInfo.value = result.dispatch || {}
    if (result.stale) dispatchError.value = '影刀暂不可用，当前为上次有效配置'
    const defaults = result.defaults
    if (!defaults) throw new Error(result.rule_error || '无法识别该计划的触发方式')
    form.timing_mode = defaults.timing_mode
    if (isCreate && !startEdited.value) form.start = defaults.start
    if (isCreate) form.bot = result.dispatch?.clients?.[0]?.name?.split('@')[0] || ''
    if (JSON.stringify(form.tags) === originalTags && (isCreate || !form.tags.length)) form.tags = [...defaults.tags]
    if (!cronEdited.value && !(props.previewOnly && props.task?._preview_modified)) cronExpression.value = defaults.expression || ''
    applyDuration()
  }).catch(error => {
    if (!current()) return
    metadataError.value = error.message
    if (isCreate) form.start = null
  }).finally(() => { if (current()) cronLoading.value = false })
  getScheduleRecentRuns(uuid).then(result => {
    if (!current()) return
    recentRuns.value = result
    applyDuration()
  }).catch(error => { if (current()) runsError.value = error.message })
    .finally(() => { if (current()) runsLoading.value = false })
}, { immediate: true })
onBeforeUnmount(() => { requestId += 1; clearPreviewNotice() })

const modalTitle = computed(() => props.mode === 'create' ? (props.allowLocalSave ? '预览/新增任务' : '新增任务') : '编辑任务')
const botOptions = computed(() => [...new Set([...props.allBots, form.bot].filter(Boolean))].map(value => ({ label: value, value })))
const tagOptions = computed(() => [...new Set([...props.allTags, ...form.tags])].map(value => ({ label: value, value })))
// 下拉选项里给周期标签加上对应 emoji 前缀（☀每日 ⭐每周 🌙每月），
// 只改下拉显示：用 render-label 而不是改 label，选中后的标签片保持纯文字
const renderTagLabel = (option) => {
  const { badge } = getTaskFrequencyBadge([option.value])
  return badge ? `${badge} ${option.label}` : option.label
}
const isCrossDayTask = computed(() => form.start && form.finish && isCrossDay(form.start, form.finish))
const durationSeconds = computed(() => elapsedBetween(form.start, form.finish) ?? 0)

const rules = computed(() => ({
  task: [{ required: true, message: '请输入任务名称', trigger: ['blur', 'input'] }],
  bot: [{ required: true, message: '请选择或输入机器人', trigger: ['blur', 'change'] }],
  start: [{ required: true, message: '请选择开始时间', trigger: 'change' }],
  finish: [{ required: true, message: '请选择结束时间', trigger: 'change' }],
  schedule_uuid: props.mode === 'create' && !props.previewOnly
    ? [{ required: true, message: '新任务必须绑定影刀计划', trigger: 'change' }]
    : [],
}))

async function onSubmit(saveLocal = false) {
  try {
    if (props.saving || hiding.value) return
    clearPreviewNotice()
    if (saveLocal && !canSaveLocal.value) return message.warning('保存到本地需要先绑定影刀计划')
    if (props.persisting && !durationEdited.value && !usableHistoricalDuration.value) return message.warning('请先手动确认耗时，或等待读取有效的运行记录')
    if (cronLoading.value) return message.warning('请等待读取影刀计划完成')
    if (props.mode === 'create' && metadataError.value) return message.warning(metadataError.value)
    await formRef.value?.validate()
    if (form.timing_mode === 'cron') {
      if (cronLoading.value) return message.warning('请等待读取影刀规则完成')
      try { parseYingdaoCron(cronExpression.value) } catch { return message.warning('请先读取有效的影刀 Cron 规则') }
      if (!Number.isInteger(form.expected_duration_seconds) || form.expected_duration_seconds < 1 || form.expected_duration_seconds > 86400) return message.warning('预计时长需要为 1–86400 秒')
    }
    const payload = {
      id: form.id,
      version: form.version,
      task: form.task,
      bot: form.bot,
      tags: [...new Set(form.tags.map(tag => tag.trim()).filter(Boolean))],
      start: normalizeTime(form.start),
      finish: normalizeTime(form.finish),
      note: form.note,
      timing_mode: form.timing_mode,
      expected_duration_seconds: form.expected_duration_seconds,
      schedule_cron_expression: cronExpression.value,
      schedule_dispatch: dispatchInfo.value,
      _local_preview_fields: { cron: cronEdited.value || Boolean(props.task?._preview_modified), dispatch: machinesEdited.value || Boolean(props.task?._preview_modified) },
    }
    if (props.mode === 'create' || saveLocal) {
      payload.schedule_uuid = form.schedule_uuid
      payload.schedule_name = form.schedule_name
    }
    emit(saveLocal ? 'save-local' : 'submit', payload)
  } catch {
    message.warning('请完善表单信息')
  }
}

function confirmDelete() {
  dialog.warning({
    title: '确认删除',
    content: props.previewOnly ? `仅在预览中隐藏“${form.task}”，刷新后恢复，不删除实际任务。` : `删除任务“${form.task}”将在下次点击保存时生效。`,
    positiveText: props.previewOnly ? '从预览移除' : '加入删除草稿',
    negativeText: '取消',
    onPositiveClick: () => emit('delete', form.id),
  })
}
</script>

<style scoped>
.editor-footer-edit { padding-top: 16px; }
.editor-secondary-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.hide-task-link { color: var(--muted, #888); font-size: 12px; }
.hide-task-link:not(:disabled):hover { color: var(--ink, #555); }
.binding-identity { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; overflow-wrap: anywhere; }
.task-mode-settings { min-width: 0; margin-bottom: 18px; }
.task-mode-panel { min-width: 0; padding: 14px; margin-bottom: 18px; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--warm); }
.task-mode-panel-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.recurring-label { padding: 3px 8px; border-radius: 4px; background: var(--soft); color: var(--accent); font-size: 13px; }
.task-mode-panel-heading small, .task-mode-hint { color: var(--muted); font-size: 12px; }
.task-mode-hint { margin: 0; }
.task-time-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.task-time-field, .task-time-duration { min-width: 0; max-width: 100%; }
.task-time-row :deep(.n-form-item-blank) { min-width: 0; width: 100%; }
.task-time-field :deep(.clock-time-picker) { width: 100%; min-width: 0; }
.task-time-row :deep(.n-form-item-label) { justify-content: center; text-align: center; }
.cron-preview { width: 100%; min-width: 0; display: grid; gap: 8px; overflow-wrap: anywhere; }
.cron-times { width: 100%; box-sizing: border-box; display: grid; grid-template-columns: repeat(auto-fill, minmax(58px, 1fr)); gap: 8px; max-height: 120px; overflow-y: auto; padding: 10px 12px; border: 1px solid var(--line); border-radius: 3px; font-variant-numeric: tabular-nums; }
@media (max-width: 480px) {
  .task-mode-panel { padding: 12px; }
  .task-time-row { gap: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .task-time-duration { grid-column: 1 / -1; grid-row: 2; }
  .task-time-row > .task-time-field:last-child { grid-column: 2; grid-row: 1; }
}
</style>
