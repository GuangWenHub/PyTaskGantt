<template>
  <n-modal :show="show" preset="card" :title="isImport ? '导入任务' : '导出任务'"
    class="responsive-modal task-transfer-modal" :mask-closable="false" :closable="!busy"
    :close-on-esc="!busy" @update:show="emit('update:show', $event)">
    <div v-if="isImport" class="transfer-file">
      <input ref="fileInput" type="file" accept=".csv,.json" hidden @change="readFile" />
      <n-button size="small" :disabled="busy" @click="fileInput?.click()">选择 CSV 或 JSON 文件</n-button>
      <span v-if="fileName">{{ fileName }}</span>
    </div>
    <n-radio-group v-else v-model:value="format" :disabled="busy" aria-label="导出格式">
      <n-radio-button value="csv">CSV</n-radio-button>
      <n-radio-button value="json">JSON</n-radio-button>
    </n-radio-group>
    <n-alert v-if="error" type="error" class="transfer-error">{{ error }}</n-alert>
    <n-spin :show="reading">
      <template v-if="rows.length">
        <div class="transfer-tools">
          <n-input v-model:value="search" clearable placeholder="搜索任务名称或机器人" aria-label="搜索任务" />
          <n-checkbox :checked="allSelected" :indeterminate="selected.size > 0 && !allSelected"
            :disabled="busy || !selectAllKeys.size" @update:checked="toggleAll">全选</n-checkbox>
          <n-button size="small" :disabled="busy || !selected.size" @click="selected = new Set()">清空</n-button>
        </div>
        <n-radio-group v-if="isImport" v-model:value="category" size="small"
          class="transfer-categories" aria-label="导入分类">
          <n-radio-button value="all">全部（{{ rows.length }}）</n-radio-button>
          <n-radio-button value="valid">可导入（{{ rows.length - invalidCount }}）</n-radio-button>
          <n-radio-button value="invalid">不可导入（{{ invalidCount }}）</n-radio-button>
        </n-radio-group>
        <div class="transfer-count" aria-live="polite">
          共 {{ rows.length }} 条，已选 {{ selected.size }} 条<span v-if="isImport && invalidCount">，{{ invalidCount }} 条不可导入</span>
          <span v-if="isImport">。每次最多导入 500 条。</span>
        </div>
        <ul v-if="filtered.length" class="transfer-list">
          <li v-for="row in pageRows" :key="row.key" class="transfer-row">
            <n-checkbox :checked="selected.has(row.key)" :disabled="busy || !selectable(row)"
              :aria-label="row.task || `第 ${row.key + 1} 条记录`" @update:checked="toggle(row, $event)" />
            <div class="transfer-row-details">
              <span>{{ row.task || `第 ${row.key + 1} 条记录` }}</span>
              <small v-if="row.bot || row.start">{{ row.bot }} · {{ row.start }}–{{ row.finish }}</small>
              <small v-if="row.error || (isImport && !selectable(row))" class="transfer-row-error">
                {{ row.error || '同一影刀计划已勾选另一条记录' }}
              </small>
            </div>
          </li>
        </ul>
        <n-empty v-else description="没有符合搜索条件的任务" />
        <n-pagination v-if="filtered.length > pageSize" v-model:page="page" :item-count="filtered.length"
          :page-size="pageSize" simple class="transfer-pages" />
      </template>
      <n-empty v-else-if="!reading" :description="isImport ? '选择文件后可勾选要导入的任务' : '暂无可导出的任务'" />
    </n-spin>
    <template #footer>
      <n-space justify="end">
        <n-button :disabled="busy" @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="submitting" :disabled="busy || !selected.size" @click="submit">
          {{ isImport ? '导入所选' : '导出所选' }}（{{ selected.size }}）
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NEmpty, NInput, NModal, NPagination, NRadioButton, NRadioGroup, NSpace, NSpin } from 'naive-ui'
import { exportTasks, importTasks, previewTaskImport } from '../services/taskService.js'

const props = defineProps({ show: Boolean, mode: String, tasks: { type: Array, default: () => [] } })
const emit = defineEmits(['update:show', 'complete'])
const isImport = computed(() => props.mode === 'import')
const format = ref('csv')
const fileInput = ref(null)
const fileName = ref('')
const fileContent = ref('')
const importRows = ref([])
const selected = ref(new Set())
const reading = ref(false)
const submitting = ref(false)
const busy = computed(() => reading.value || submitting.value)
const error = ref('')
const search = ref('')
const category = ref('all')
const page = ref(1)
const pageSize = 20
const maxImportCount = 500
const rows = computed(() => isImport.value ? importRows.value : props.tasks.map(task => ({ ...task, key: String(task.id) })))
const invalidCount = computed(() => importRows.value.filter(row => row.error).length)
const selectedPlans = computed(() => new Set(importRows.value.filter(row => selected.value.has(row.key)).map(row => row.schedule_uuid)))
const selectAllKeys = computed(() => {
  if (!isImport.value) return new Set(rows.value.map(row => row.key))
  const keys = new Set(selected.value)
  const plans = new Set(selectedPlans.value)
  for (const row of rows.value) {
    if (keys.size >= maxImportCount) break
    if (row.error || plans.has(row.schedule_uuid)) continue
    keys.add(row.key)
    plans.add(row.schedule_uuid)
  }
  return keys
})
const allSelected = computed(() => selected.value.size > 0 && selected.value.size === selectAllKeys.value.size)
const filtered = computed(() => {
  const term = search.value.trim().toLowerCase()
  return rows.value.filter(row => {
    if (isImport.value && category.value === 'valid' && row.error) return false
    if (isImport.value && category.value === 'invalid' && !row.error) return false
    return [row.task, row.bot].some(value => String(value || '').toLowerCase().includes(term))
  })
})
const pageRows = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch([search, category, () => filtered.value.length], () => { page.value = 1 })
watch(() => props.tasks, tasks => {
  if (isImport.value || !props.show) return
  const available = new Set(tasks.map(task => String(task.id)))
  selected.value = new Set([...selected.value].filter(key => available.has(key)))
})
watch(() => props.show, show => {
  if (!show) return
  selected.value = new Set()
  fileName.value = ''
  fileContent.value = ''
  importRows.value = []
  search.value = ''
  category.value = 'all'
  format.value = 'csv'
  error.value = ''
  page.value = 1
})

function selectable(row) {
  return !row.error && (!isImport.value || selected.value.has(row.key) || !selectedPlans.value.has(row.schedule_uuid))
}

function toggle(row, checked) {
  if (busy.value || !selectable(row)) return
  if (!checked) { selected.value.delete(row.key); return }
  if (isImport.value && selected.value.size >= maxImportCount) {
    error.value = '每次最多导入 500 条，请分批选择'
    return
  }
  selected.value.add(row.key)
}

function toggleAll(checked) {
  if (busy.value) return
  selected.value = checked ? new Set(selectAllKeys.value) : new Set()
}

async function readFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || busy.value) return
  selected.value = new Set()
  importRows.value = []
  fileContent.value = ''
  fileName.value = file.name
  error.value = ''
  search.value = ''
  category.value = 'all'
  reading.value = true
  try {
    const extension = file.name.split('.').pop().toLowerCase()
    if (!['csv', 'json'].includes(extension)) throw new Error('请选择 CSV 或 JSON 文件')
    const content = await file.text()
    const result = await previewTaskImport(content, extension)
    format.value = extension
    fileContent.value = content
    importRows.value = result.rows.map(row => ({ ...row, key: row.index }))
    if (!importRows.value.length) error.value = '文件中没有任务记录'
  } catch (failure) {
    error.value = failure.message
  } finally {
    reading.value = false
  }
}

async function submit() {
  if (busy.value || !selected.value.size) return
  const keys = [...selected.value]
  const mode = props.mode
  const fileFormat = format.value
  error.value = ''
  submitting.value = true
  try {
    const result = isImport.value
      ? await importTasks(fileContent.value, fileFormat, keys.sort((a, b) => a - b))
      : await exportTasks(fileFormat, keys)
    emit('update:show', false)
    emit('complete', { mode, count: keys.length, format: fileFormat, message: result?.message })
  } catch (failure) {
    error.value = failure.message
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.task-transfer-modal { width: min(680px, calc(100vw - 32px)); }
.transfer-file, .transfer-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.transfer-tools, .transfer-error, .transfer-categories { margin-top: 12px; }
.transfer-tools .n-input { flex: 1 1 180px; }
.transfer-file span, .transfer-row-details { min-width: 0; overflow-wrap: anywhere; }
.transfer-count { margin: 10px 0; color: var(--muted); }
.transfer-list { padding: 0; margin: 0; list-style: none; max-height: 44vh; overflow: auto; }
.transfer-row { display: flex; align-items: center; gap: 12px; padding: 8px; border-bottom: 1px solid var(--line-soft); }
.transfer-row-details { display: grid; gap: 2px; }
.transfer-row-details small { color: var(--muted); }
.transfer-row-details .transfer-row-error { color: #a13232; }
.transfer-pages { margin-top: 12px; justify-content: end; }
</style>
