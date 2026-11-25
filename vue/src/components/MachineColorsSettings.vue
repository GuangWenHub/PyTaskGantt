<template>
  <section class="machine-colors" aria-label="机器颜色设置">
    <p class="machine-colors-description">在调色板中选择颜色后点击应用，保存在当前浏览器，登录时续期一年。灰色色块为不可选的近似状态色。</p>
    <div v-for="bot in bots" :key="bot" class="machine-color-row">
      <div class="machine-color-name"><span class="machine-color-dot" :style="{ background: colors[bot] || defaults[bot] }" /><strong>{{ bot }}</strong><small>{{ colors[bot] ? '自定义' : '默认色' }}</small></div>
      <div class="machine-color-controls">
        <MachineColorPalette :machine="bot" :value="drafts[bot] || colors[bot]" @update:value="value => drafts[bot] = value" />
        <span v-if="drafts[bot]" class="machine-color-value">{{ drafts[bot] }}</span>
        <n-button size="small" type="primary" :disabled="!drafts[bot] || Boolean(machineColorError(drafts[bot]))" @click="apply(bot)">应用</n-button>
        <n-button size="small" quaternary :disabled="!colors[bot]" @click="resetColor(bot)">恢复默认</n-button>
      </div>
      <small v-if="drafts[bot] && machineColorError(drafts[bot])" class="machine-color-error" role="alert">{{ machineColorError(drafts[bot]) }}</small>
      <small v-else-if="messages[bot]" role="status">{{ messages[bot] }}</small>
    </div>
    <p v-if="!bots.length">暂无可设置的机器</p>
  </section>
</template>
<script setup>
import { computed, reactive } from 'vue'
import { NButton } from 'naive-ui'
import { candidateNames, projectSharedTasks } from '../../shared/scheduleDispatch.mjs'
import { machineColorError } from '../../shared/machineColors.mjs'
import MachineColorPalette from './MachineColorPalette.vue'
import { filterTasks } from '../services/dataService.js'
import { useMachineColorPreference } from '../services/machineColorPreference.js'
const props = defineProps({ tasks: { type: Array, default: () => [] } })
const { colors, save, reset } = useMachineColorPreference()
const drafts = reactive({}), messages = reactive({})
const bots = computed(() => [...new Set(props.tasks.flatMap(candidateNames).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const defaults = computed(() => Object.fromEntries(projectSharedTasks(filterTasks(props.tasks)).map(task => [task.bot, task.color])))
function apply(bot) { if (save(bot, drafts[bot])) { drafts[bot] = colors.value[bot]; messages[bot] = '已保存到当前浏览器' } }
function resetColor(bot) { reset(bot); drafts[bot] = ''; messages[bot] = '已恢复默认颜色' }
</script>
<style scoped>
.machine-colors-description, .machine-colors small { color: var(--muted); font-size: 12px; }
.machine-color-row { padding: 14px 0; border-bottom: 1px solid var(--line); }
.machine-color-name, .machine-color-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 8px; }
.machine-color-name strong { overflow-wrap: anywhere; }
.machine-color-dot { width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto; }
.machine-colors .machine-color-error { color: var(--danger, #c5414e); }
</style>
