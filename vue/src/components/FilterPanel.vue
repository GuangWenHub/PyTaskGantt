<template>
  <n-card title="筛选与操作" size="small" :bordered="true" class="filter-panel">
    <div class="filter-section filter-stats">
      <div class="stat-card stat-card-blue">
        <strong>{{ filteredCount }}</strong><span>当前显示</span>
      </div>
      <div class="stat-card stat-card-gray">
        <strong>{{ totalCount }}</strong><span>总任务数</span>
      </div>
    </div>

    <div class="filter-section filter-primary-actions">
      <n-button type="primary" block @click="$emit('create')">{{ previewOnly ? '预览/新增任务' : '新增任务' }}</n-button>
      <div v-if="previewOnly" class="plan-sync-button">
        <n-button block type="primary" secondary :aria-label="syncUnread ? '同步影刀计划，有未查看的核对结果' : '同步影刀计划'" @click="$emit('reconcile')">{{ syncRunning ? '后台核对中…' : '同步影刀计划' }}</n-button>
        <span v-if="syncUnread" class="plan-sync-unread" role="status" aria-label="有未查看的核对结果" />
      </div>
    </div>

    <div class="filter-section">
      <n-button-group size="small" class="filter-button-group">
        <n-button @click="$emit('refresh')" :title="previewOnly ? '清除预览调整并刷新' : '丢弃草稿并刷新'">刷新</n-button>
        <n-button @click="triggerImport">导入</n-button>
        <n-dropdown :options="exportOptions" @select="key => $emit('export', key)" trigger="click">
          <n-button>导出</n-button>
        </n-dropdown>
      </n-button-group>
      <input ref="fileInputRef" type="file" accept=".csv,.json" hidden @change="onFileSelected" />
      <n-button
        v-if="!previewOnly"
        :type="hasUnsaved ? 'warning' : 'primary'"
        :disabled="!hasUnsaved"
        :loading="saving"
        block
        class="filter-save-button"
        @click="$emit('save')"
      >
        {{ hasUnsaved ? `保存 ${mutationCount} 项修改` : '没有待保存修改' }}
      </n-button>
    </div>

    <div class="filter-section">
      <div class="section-title"><span>筛选</span></div>
      <n-input
        :value="searchTerm"
        clearable
        size="small"
        placeholder="搜索任务名称"
        @update:value="value => $emit('update:searchTerm', value)"
      />

      <div class="filter-control">
        <label>机器人</label>
        <n-select
          :value="selectedBots"
          :options="botOptions"
          multiple
          clearable
          size="small"
          placeholder="全部机器人"
          @update:value="value => $emit('update:selectedBots', value)"
        />
      </div>

      <div class="filter-control">
        <label>所有者</label>
        <n-select
          :value="selectedOwners"
          :options="ownerOptions"
          multiple
          clearable
          size="small"
          placeholder="全部所有者"
          @update:value="value => $emit('update:selectedOwners', value)"
        />
      </div>

      <div class="filter-control">
        <label>排序</label>
        <n-radio-group
          :value="sortBy"
          size="small"
          @update:value="value => $emit('update:sortBy', value)"
        >
          <n-radio-button value="bot">机器人</n-radio-button>
          <n-radio-button value="time">时间</n-radio-button>
          <n-radio-button value="owner">所有者</n-radio-button>
        </n-radio-group>
      </div>
    </div>

  </n-card>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  NButton,
  NButtonGroup,
  NCard,
  NDropdown,
  NInput,
  NRadioButton,
  NRadioGroup,
  NSelect,
} from 'naive-ui'

const props = defineProps({
  previewOnly: { type: Boolean, default: false },
  syncUnread: Boolean,
  syncRunning: Boolean,
  searchTerm: { type: String, default: '' },
  selectedBots: { type: Array, default: () => [] },
  selectedOwners: { type: Array, default: () => [] },
  sortBy: { type: String, default: 'bot' },
  allBots: { type: Array, default: () => [] },
  allOwners: { type: Array, default: () => [] },
  filteredCount: { type: Number, default: 0 },
  totalCount: { type: Number, default: 0 },
  hasUnsaved: { type: Boolean, default: false },
  mutationCount: { type: Number, default: 0 },
  saving: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:searchTerm', 'update:selectedBots', 'update:selectedOwners', 'update:sortBy',
  'refresh', 'import', 'export', 'create', 'save', 'reconcile',
])

const exportOptions = [
  { label: '导出为 CSV', key: 'csv' },
  { label: '导出为 JSON', key: 'json' },
]
const botOptions = computed(() => props.allBots.map(value => ({ label: value, value })))
const ownerOptions = computed(() => props.allOwners.map(owner => ({
  label: owner.display_name,
  value: owner.id,
})))
const fileInputRef = ref(null)

function triggerImport() {
  fileInputRef.value?.click()
}

function onFileSelected(event) {
  const file = event.target.files?.[0]
  if (file) {
    event.target.value = ''
    emit('import', file)
  }
}
</script>
<style scoped>
.filter-primary-actions { display: flex; gap: 8px; }
.filter-primary-actions > * { flex: 1 1 0; min-width: 0; }
.filter-primary-actions :deep(.n-button) { width: 100%; padding-inline: 6px; }
.plan-sync-button { position: relative; }
.plan-sync-unread { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: 50%; background: #e53935; border: 2px solid var(--surface, #fff); pointer-events: none; }
</style>
