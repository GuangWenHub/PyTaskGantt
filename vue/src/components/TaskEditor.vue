<template>
  <n-modal
    :show="show"
    preset="card"
    :title="modalTitle"
    class="responsive-modal task-editor-modal"
    :mask-closable="false"
    :bordered="false"
    @update:show="value => $emit('update:show', value)"
  >
    <n-form ref="formRef" :model="form" :rules="rules" label-placement="top">
      <div :class="{ 'task-editor-folder': mode === 'create' }">
      <div v-if="mode === 'create'" class="task-type-cards" role="group" aria-label="任务类型">
        <button type="button" class="task-type-card" title="设置开始和结束时间" :class="{ 'is-selected': form.timing_mode === 'single' }" :aria-pressed="form.timing_mode === 'single'" @click="form.timing_mode = 'single'">
          <span class="task-type-icon" aria-hidden="true">◷</span>
          <strong>常规任务</strong>
        </button>
        <button type="button" class="task-type-card" title="按影刀规则多次触发" :class="{ 'is-selected': form.timing_mode === 'cron' }" :aria-pressed="form.timing_mode === 'cron'" @click="form.timing_mode = 'cron'">
          <span class="task-type-icon" aria-hidden="true">🔁</span>
          <strong>循环任务</strong>
        </button>
      </div>
      <div :class="{ 'task-folder-content': mode === 'create', 'task-folder-content-rounded': mode === 'create' && form.timing_mode === 'cron' }">
      <n-form-item v-if="mode === 'create'" label="绑定影刀计划" path="schedule_uuid">
        <SchedulePicker
          v-model="form.schedule_uuid"
          :selected-name="form.schedule_name"
          :reserved-uuids="reservedScheduleUuids"
          @select="schedule => form.schedule_name = schedule?.schedule_name || ''"
        />
      </n-form-item>
      <n-form-item v-else label="当前影刀计划">
        <div class="current-binding">
          <div class="binding-identity"><code>{{ form.schedule_uuid || '未绑定，仅可只读展示' }}</code><span v-if="form.schedule_uuid">{{ form.schedule_name || '名称暂未获取' }}</span></div>
          <small v-if="form.schedule_uuid">如需更换计划，请在“我的任务”页面使用“换绑”。</small>
        </div>
      </n-form-item>

      <n-form-item label="任务名称" path="task">
        <n-input v-model:value="form.task" placeholder="例如：登录系统" maxlength="100" show-count />
      </n-form-item>

      <n-form-item :label="botLabel" path="bot">
        <n-select
          :value="selectedBots"
          :options="machineOptions"
          :disabled="hasScheduleClients"
          :max="hasScheduleClients ? undefined : 1"
          multiple
          placeholder="选择或输入新机器人"
          filterable
          tag
          @update:value="values => form.bot = values[0] || ''"
        />
        <template v-if="dispatchError" #feedback>{{ dispatchError }}</template>
      </n-form-item>

      <section v-if="form.timing_mode === 'cron'" class="task-mode-settings" :class="{ 'task-mode-panel': mode === 'create' }" aria-label="循环任务设置">
        <div class="task-mode-panel-heading"><span class="recurring-label">🔁 循环任务</span><small>自动标识，无需设置标签</small></div>
        <n-form-item label="单次预计时长（秒）">
          <n-input-number v-model:value="form.expected_duration_seconds" :min="1" :max="86400" :precision="0" />
        </n-form-item>
        <n-form-item label="影刀循环规则（只读）">
          <div class="cron-preview">
            <n-input :value="cronExpression" readonly aria-label="影刀循环规则" :placeholder="cronLoading ? '正在读取…' : '请先绑定有循环规则的影刀计划'" />
            <div v-if="cronExpression">{{ cronSummary }}</div>
            <n-button size="small" quaternary type="primary" :disabled="!form.schedule_uuid" :loading="cronLoading" @click="loadCron">重新读取规则</n-button>
          </div>
        </n-form-item>
        <n-form-item v-if="cronTimes.length" label="触发时刻">
          <div class="cron-times" role="region" aria-label="全部触发时刻" tabindex="0"><span v-for="time in cronTimes" :key="time">{{ time }}</span></div>
        </n-form-item>
        <p class="task-mode-hint">规则来自影刀计划，统一展示每日时间模板。</p>
        <n-alert v-if="cronError" type="warning" class="editor-alert">{{ cronError }}</n-alert>
      </section>
      <section v-else :class="{ 'task-mode-panel': mode === 'create' }" aria-label="常规任务设置">
        <n-form-item label="标签">
          <n-select v-model:value="form.tags" :options="tagOptions" :render-label="renderTagLabel" placeholder="输入标签后回车" filterable multiple tag />
        </n-form-item>
        <n-grid cols="1 560:2" :x-gap="16">
          <n-form-item-gi label="开始时间" path="start">
            <n-time-picker v-model:formatted-value="form.start" value-format="HH:mm:ss" format="HH:mm:ss" />
          </n-form-item-gi>
          <n-form-item-gi label="结束时间" path="finish">
            <n-time-picker v-model:formatted-value="form.finish" value-format="HH:mm:ss" format="HH:mm:ss" />
          </n-form-item-gi>
        </n-grid>
        <n-alert v-if="isCrossDayTask" type="info" :show-icon="true" class="editor-alert">已识别为跨天任务（实际时长约 {{ durationText }}）</n-alert>
      </section>

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
      </div>
      </div>
    </n-form>

    <template #footer>
      <div class="editor-footer">
        <n-button v-if="mode === 'edit'" type="error" ghost @click="confirmDelete">删除任务</n-button>
        <span v-else></span>
        <n-space>
          <n-button @click="$emit('update:show', false)">取消</n-button>
          <n-button type="primary" @click="onSubmit">
            {{ mode === 'create' ? '加入待保存草稿' : '保存到草稿' }}
          </n-button>
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
  NFormItemGi,
  NGrid,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  NTimePicker,
  useDialog,
  useMessage,
} from 'naive-ui'
import SchedulePicker from './SchedulePicker.vue'
import { formatDuration, getTaskFrequencyBadge, isCrossDay, normalizeTime } from '../services/dataService.js'
import { getScheduleCron, getScheduleDispatch, getSchedules } from '../services/yingdaoService.js'
import { cronTemplateSummary, parseYingdaoCron } from '../../shared/yingdaoCron.mjs'

const props = defineProps({
  show: { type: Boolean, default: false },
  mode: { type: String, default: 'create' },
  task: { type: Object, default: () => ({}) },
  allBots: { type: Array, default: () => [] },
  allTags: { type: Array, default: () => [] },
  reservedScheduleUuids: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:show', 'submit', 'delete'])
const message = useMessage()
const dialog = useDialog()
const formRef = ref(null)
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
let cronRequest = 0
const dispatchInfo = ref({})
const dispatchError = ref('')
let dispatchRequest = 0
watch(() => [props.show, form.schedule_uuid], async () => {
  const request = ++dispatchRequest
  dispatchInfo.value = props.task?.schedule_uuid === form.schedule_uuid ? props.task?.schedule_dispatch || {} : {}
  dispatchError.value = ''
  if (!props.show || !form.schedule_uuid) return
  const uuid = form.schedule_uuid
  const [dispatch, schedules] = await Promise.allSettled([
    getScheduleDispatch(uuid),
    getSchedules({ query: uuid, include_bound: true, size: 20 }),
  ])
  if (request !== dispatchRequest) return
  if (dispatch.status === 'fulfilled') {
    dispatchInfo.value = dispatch.value.dispatch
    dispatchError.value = dispatch.value.stale ? '影刀暂不可用，当前为上次有效配置' : ''
  } else dispatchError.value = dispatch.reason.message
  if (schedules.status === 'fulfilled') {
    const schedule = schedules.value.schedules.find(item => item.schedule_uuid === uuid)
    if (schedule?.schedule_name) form.schedule_name = schedule.schedule_name
  }
})
const hasScheduleClients = computed(() => Boolean(dispatchInfo.value.clients?.length))
const selectedBots = computed(() => hasScheduleClients.value ? dispatchInfo.value.clients.map(client => client.id) : (form.bot ? [form.bot] : []))
const machineOptions = computed(() => hasScheduleClients.value ? dispatchInfo.value.clients.map(client => ({ label: client.name, value: client.id })) : botOptions.value)
const botLabel = computed(() => `机器人 / Bot${hasScheduleClients.value && dispatchInfo.value.clients.length > 1 ? (dispatchInfo.value.execute_scope === 'any' ? '（共享 · 任选1台）' : dispatchInfo.value.execute_scope === 'all' ? '（全部执行）' : '') : ''}`)
const cronSummary = computed(() => cronTemplateSummary(cronExpression.value, form.expected_duration_seconds))
const cronTimes = computed(() => {
  try { return parseYingdaoCron(cronExpression.value).seconds.map(s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(s % 3600 / 60).padStart(2, '0')}`) }
  catch { return [] }
})
async function loadCron() {
  const request = ++cronRequest
  if (!props.show || form.timing_mode !== 'cron' || !form.schedule_uuid) { cronLoading.value = false; return }
  cronLoading.value = true
  cronError.value = ''
  try {
    const result = await getScheduleCron(form.schedule_uuid)
    if (request !== cronRequest) return
    cronExpression.value = result.expression
    cronError.value = result.stale ? '影刀暂不可用，当前为上次缓存规则' : ''
  } catch (error) { if (request === cronRequest) cronError.value = error.message }
  finally { if (request === cronRequest) cronLoading.value = false }
}
watch(() => [props.show, form.timing_mode, form.schedule_uuid], () => {
  cronExpression.value = props.task?.schedule_uuid === form.schedule_uuid ? props.task?.schedule_cron_expression || '' : ''
  loadCron()
})
onBeforeUnmount(() => { cronRequest += 1; dispatchRequest += 1 })

watch(() => [props.show, props.task], () => {
  if (!props.show) return
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

const modalTitle = computed(() => props.mode === 'create' ? '新增任务' : '编辑任务')
const botOptions = computed(() => [...new Set([...props.allBots, form.bot].filter(Boolean))].map(value => ({ label: value, value })))
const tagOptions = computed(() => [...new Set([...props.allTags, ...form.tags])].map(value => ({ label: value, value })))
// 下拉选项里给周期标签加上对应 emoji 前缀（☀每日 ⭐每周 🌙每月），
// 只改下拉显示：用 render-label 而不是改 label，选中后的标签片保持纯文字
const renderTagLabel = (option) => {
  const { badge } = getTaskFrequencyBadge([option.value])
  return badge ? `${badge} ${option.label}` : option.label
}
const isCrossDayTask = computed(() => form.start && form.finish && isCrossDay(form.start, form.finish))
const durationText = computed(() => formatDuration(form.start, form.finish))

const rules = computed(() => ({
  task: [{ required: true, message: '请输入任务名称', trigger: ['blur', 'input'] }],
  bot: [{ required: true, message: '请选择或输入机器人', trigger: ['blur', 'change'] }],
  start: [{ required: true, message: '请选择开始时间', trigger: 'change' }],
  finish: [{ required: true, message: '请选择结束时间', trigger: 'change' }],
  schedule_uuid: props.mode === 'create'
    ? [{ required: true, message: '新任务必须绑定影刀计划', trigger: 'change' }]
    : [],
}))

async function onSubmit() {
  try {
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
    }
    if (props.mode === 'create') {
      payload.schedule_uuid = form.schedule_uuid
      payload.schedule_name = form.schedule_name
    }
    emit('submit', payload)
  } catch {
    message.warning('请完善表单信息')
  }
}

function confirmDelete() {
  dialog.warning({
    title: '确认删除',
    content: `删除任务“${form.task}”将在下次点击保存时生效。`,
    positiveText: '加入删除草稿',
    negativeText: '取消',
    onPositiveClick: () => emit('delete', form.id),
  })
}
</script>

<style scoped>
.task-editor-folder { padding-top: 6px; isolation: isolate; }
.binding-identity { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; overflow-wrap: anywhere; }
.task-type-cards { position: relative; display: flex; gap: 6px; align-items: flex-end; margin-bottom: -1px; }
.task-type-card { position: relative; display: flex; align-items: center; justify-content: center; gap: 8px; min-width: 132px; height: 42px; padding: 0 20px; border: 1px solid #cbd6e5; border-bottom: 0; border-radius: 10px 10px 0 0; background: linear-gradient(#edf2f9, #dde6f2); color: #68778b; font: inherit; font-size: 13px; cursor: pointer; transform: translateY(3px); box-shadow: 0 -2px 4px rgba(35, 62, 98, .05); transition: transform .15s, background-color .15s, color .15s; }
.task-type-card:hover { border-color: #1677ff; }
.task-type-card:focus-visible { outline: 2px solid #1677ff; outline-offset: 2px; }
.task-type-card.is-selected { z-index: 2; height: 46px; border-color: #b5c9e4; background: #fff; color: #1677ff; transform: translateY(0); box-shadow: 0 -3px 8px rgba(35, 62, 98, .1); }
.task-type-card.is-selected::after { content: ''; position: absolute; right: 0; bottom: -2px; left: 0; height: 4px; background: #fff; }
.task-type-icon { font-size: 18px; flex-shrink: 0; }
.task-mode-settings { min-width: 0; margin-bottom: 18px; }
.task-folder-content { position: relative; z-index: 1; min-width: 0; padding: 20px 18px 2px; border: 1px solid #b5c9e4; border-radius: 0 8px 8px 8px; background: #fff; box-shadow: 0 3px 10px rgba(35, 62, 98, .06); }
.task-folder-content-rounded { border-top-left-radius: 8px; }
.task-mode-panel { min-width: 0; padding: 14px; margin-bottom: 18px; border: 1px solid #e8edf4; border-radius: 8px; background: #fafcff; }
.task-mode-panel-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.recurring-label { padding: 3px 8px; border-radius: 4px; background: #e6f1ff; color: #1677ff; font-size: 13px; }
.task-mode-panel-heading small, .task-mode-hint { color: #777; font-size: 12px; }
.task-mode-hint { margin: 0; }
.cron-preview { width: 100%; min-width: 0; display: grid; gap: 8px; overflow-wrap: anywhere; }
.cron-times { width: 100%; box-sizing: border-box; display: grid; grid-template-columns: repeat(auto-fill, minmax(58px, 1fr)); gap: 8px; max-height: 120px; overflow-y: auto; padding: 10px 12px; border: 1px solid #e0e0e6; border-radius: 3px; font-variant-numeric: tabular-nums; }
@media (max-width: 480px) {
  .task-type-cards { gap: 4px; }
  .task-type-card { min-width: 0; padding: 0 15px; gap: 6px; }
  .task-type-icon { font-size: 16px; }
  .task-folder-content { padding: 16px 12px 0; }
  .task-mode-panel { padding: 12px; }
}
</style>
