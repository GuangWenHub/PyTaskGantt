<template>
  <n-modal :show="show" preset="card" :title="editingColors ? '机器颜色' : adding ? '添加隐藏任务' : editingHidden ? '隐藏任务名单' : '甘特图设置'" class="hidden-tasks-dialog" :style="{ width: 'min(700px, calc(100vw - 32px))' }" :mask-closable="!saving" :closable="!saving" @update:show="value => $emit('update:show', value)">
    <div class="hidden-tasks-body">
      <MachineColorsSettings v-if="editingColors" :tasks="tasks" />
      <template v-else>
      <template v-if="!editingHidden">
      <div class="task-name-setting">
        <div><strong>自动滚动</strong><div class="hidden-task-meta">打开或刷新页面时自动滑动到当前时间并居中；默认关闭，设置保存在当前浏览器。</div></div>
        <n-switch :value="autoScroll" aria-label="自动滚动" @update:value="value => $emit('update:autoScroll', value)" />
      </div>
      <div v-if="!adding" class="task-name-setting"><div><strong>机器颜色</strong><div class="hidden-task-meta">自定义各台机器颜色，排除与运行状态相近的颜色。</div></div><n-button size="small" @click="editingColors = true">自定义颜色</n-button></div>
      <div v-if="!adding" class="task-name-setting">
        <div><strong>显示参考线</strong><div class="hidden-task-meta">每天 8:30 和 17:30 的固定参考线，统一开启或关闭；默认开启。</div></div>
        <n-switch :value="showReferenceLines" aria-label="显示参考线" @update:value="value => $emit('update:showReferenceLines', value)" />
      </div>
      <div v-if="!adding" class="task-name-setting">
        <div><strong>显示当前时间线</strong><div class="hidden-task-meta">用竖线标记当前北京时间，随时间自动更新；默认关闭。</div></div>
        <n-switch :value="showCurrentTimeLine" aria-label="显示当前时间线" @update:value="value => $emit('update:showCurrentTimeLine', value)" />
      </div>
      <div v-if="!adding" class="task-name-setting">
        <div><strong>显示隐藏任务</strong><div class="hidden-task-meta">开启后显示名单内的任务；默认关闭。已隐藏 {{ hiddenRows.length }} 个任务，名单由所有账号共用，显示偏好仅保存在当前浏览器。</div></div>
        <div class="hidden-task-setting-actions">
          <n-button size="small" @click="editingHidden = true">设置名单</n-button>
          <n-switch :value="showHiddenTasks" aria-label="显示隐藏任务" @update:value="value => $emit('update:showHiddenTasks', value)" />
        </div>
      </div>
      <div v-if="!adding" class="task-name-setting">
        <div><strong>任务条上显示名称</strong><div class="hidden-task-meta">开关即时生效并自动记住；开启时默认收起左侧任务栏，可手动展开。</div></div>
        <n-switch :value="showTaskNames" aria-label="任务条上显示名称" @update:value="value => $emit('update:showTaskNames', value)" />
      </div>
      <div v-if="!adding" class="task-name-setting">
        <div><strong>显示今日运行状态</strong><div class="hidden-task-meta">灰色未运行 · 蓝色处理中 · 绿色成功 · 红色异常。重试后最终成功仍为绿色。</div></div>
        <n-switch :value="showRunStatus" aria-label="显示今日运行状态" @update:value="value => $emit('update:showRunStatus', value)" />
      </div>
      </template>
      <template v-else>
      <template v-if="adding">
        <n-input v-model:value="search" clearable placeholder="搜索任务名称" aria-label="搜索任务名称" />
        <div class="hidden-task-categories">
          <n-button v-for="category in categories" :key="category.value" size="small" :type="kind === category.value ? 'primary' : 'default'" :secondary="kind === category.value" @click="kind = category.value">{{ category.label }}</n-button>
        </div>
        <div class="hidden-task-count">已选择 {{ selected.length }} 项</div>
      </template>
      <div v-else class="hidden-task-toolbar">
        <span>已隐藏 {{ hiddenRows.length }} 个任务 · 所有账号共用</span>
        <n-button type="primary" size="small" :disabled="saving" @click="openAdd">添加</n-button>
      </div>
      <div class="hidden-task-rows">
        <div v-for="task in displayedRows" :key="task.id" class="hidden-task-row">
          <n-checkbox v-if="adding" :checked="selected.includes(String(task.id))" :aria-label="task.task" @update:checked="value => selectTask(task.id, value)" />
          <div class="hidden-task-description"><div class="hidden-task-name">{{ task.task }}</div><div class="hidden-task-meta">{{ task.bot || '未指定机器' }} · {{ taskTypes(task).join(' / ') }}</div></div>
          <n-button v-if="!adding" size="tiny" quaternary :disabled="saving" @click="removeTask(task.id)">移出名单</n-button>
        </div>
        <n-empty v-if="!displayedRows.length" :description="adding ? '没有符合条件的任务' : '暂无隐藏任务'" class="hidden-task-empty" />
      </div>
      </template>
      </template>
    </div>
    <template #footer>
      <div class="hidden-task-footer">
        <n-button v-if="editingColors" @click="editingColors = false">返回设置</n-button>
        <template v-else-if="editingHidden">
        <n-button :disabled="saving" @click="adding ? adding = false : editingHidden = false">{{ adding ? '返回名单' : '返回设置' }}</n-button>
        <n-button v-if="adding" type="primary" :disabled="!selected.length" @click="addSelected">添加所选（{{ selected.length }}）</n-button>
        <n-button v-else type="primary" :loading="saving" @click="save">保存名单</n-button>
        </template>
        <n-button v-else @click="$emit('update:show', false)">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NEmpty, NInput, NModal, NSwitch } from 'naive-ui'
import MachineColorsSettings from './MachineColorsSettings.vue'
import { isSharedTask } from '../../shared/scheduleDispatch.mjs'
const props = defineProps({ autoScroll: Boolean, showReferenceLines: { type: Boolean, default: true }, showCurrentTimeLine: Boolean, showHiddenTasks: Boolean, showRunStatus: Boolean, showTaskNames: { type: Boolean, default: true }, show: Boolean, tasks: { type: Array, default: () => [] }, saving: Boolean })
const emit = defineEmits(['update:autoScroll', 'update:show', 'save', 'update:showTaskNames', 'update:showRunStatus', 'update:showHiddenTasks', 'update:showCurrentTimeLine', 'update:showReferenceLines'])
const editingColors = ref(false)
const editingHidden = ref(false)
const adding = ref(false), search = ref(''), kind = ref('all'), selected = ref([]), hidden = ref([])
let baseline = new Map()
const categories = [{ value: 'all', label: '全部任务' }, { value: 'cron', label: '循环任务' }, { value: 'shared', label: '共享任务' }, { value: 'normal', label: '普通任务' }]
const savedTasks = computed(() => props.tasks.filter(task => /^[1-9]\d*$/.test(String(task.id))))
watch(() => props.show, show => {
  if (!show) return
  baseline = new Map(savedTasks.value.map(task => [String(task.id), Boolean(task.is_hidden)]))
  hidden.value = [...baseline].filter(([, value]) => value).map(([id]) => id)
  adding.value = false
  editingColors.value = false
  editingHidden.value = false
}, { immediate: true })
const hiddenRows = computed(() => savedTasks.value.filter(task => hidden.value.includes(String(task.id))))
function taskTypes(task) {
  const types = []
  if (task.timing_mode === 'cron') types.push('循环任务')
  if (isSharedTask(task)) types.push('共享任务')
  return types.length ? types : ['普通任务']
}
const displayedRows = computed(() => {
  if (!adding.value) return hiddenRows.value
  const term = search.value.trim().toLocaleLowerCase('zh-CN')
  return savedTasks.value.filter(task => !hidden.value.includes(String(task.id))
    && (!term || task.task.toLocaleLowerCase('zh-CN').includes(term))
    && (kind.value === 'all' || (kind.value === 'cron' && task.timing_mode === 'cron')
      || (kind.value === 'shared' && isSharedTask(task))
      || (kind.value === 'normal' && task.timing_mode !== 'cron' && !isSharedTask(task))))
})
function openAdd() { adding.value = true; selected.value = []; search.value = ''; kind.value = 'all' }
function selectTask(id, checked) { id = String(id); selected.value = checked ? [...new Set([...selected.value, id])] : selected.value.filter(value => value !== id) }
function removeTask(id) { hidden.value = hidden.value.filter(value => value !== String(id)) }
function addSelected() { hidden.value = [...new Set([...hidden.value, ...selected.value])]; selected.value = []; adding.value = false }
function save() {
  const changes = [...baseline].filter(([id, old]) => hidden.value.includes(id) !== old)
    .map(([id, expected_hidden]) => ({ id, expected_hidden, is_hidden: hidden.value.includes(id) }))
  emit('save', changes)
}
</script>

<style scoped>
.task-name-setting { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--line, #eee); }
.hidden-task-setting-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.hidden-tasks-body { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.hidden-task-toolbar, .hidden-task-categories, .hidden-task-footer { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.hidden-task-toolbar { justify-content: space-between; }
.hidden-task-count, .hidden-task-meta { color: var(--text-secondary, #888); font-size: 12px; }
.hidden-task-rows { overflow-y: auto; max-height: min(52vh, 500px); min-height: 100px; }
.hidden-task-row { display: flex; gap: 12px; padding: 12px; align-items: center; border-radius: 4px; }
.hidden-task-row:nth-child(odd) { background: var(--bg-secondary, rgba(128,128,128,.07)); }
.hidden-task-description { flex: 1; min-width: 0; }
.hidden-task-name { overflow-wrap: anywhere; }
.hidden-task-footer { justify-content: flex-end; }
.hidden-task-empty { padding: 24px 0; }
</style>

<style>
.hidden-tasks-dialog { max-height: calc(100dvh - 32px); display: flex; flex-direction: column; }
.hidden-tasks-dialog > .n-card-content { min-height: 0; overflow-y: auto; }
.hidden-tasks-dialog > .n-card-header, .hidden-tasks-dialog > .n-card__footer { flex-shrink: 0; }
</style>
