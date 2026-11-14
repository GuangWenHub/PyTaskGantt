<template>
  <div class="machine-palette" :class="{ 'is-open': open }">
    <button class="machine-palette-trigger" type="button" :aria-label="`${machine}调色板`" :aria-expanded="open" @click="open = !open"><span :style="{ background: value || '#b7791f' }" />调色板</button>
    <div v-if="open" class="machine-palette-panel">
      <div class="machine-palette-grid" role="group" :aria-label="`${machine}颜色调色板`">
        <button v-for="cell in cells" :key="cell.key" type="button" class="machine-palette-cell" :style="{ background: cell.disabled ? '#9b9b9b' : cell.color }" :disabled="cell.disabled" :aria-label="`${machine}颜色${cell.color}${cell.disabled ? '（禁用）' : ''}`" :title="cell.disabled ? '与运行状态色相近，不可选择' : cell.color" @click="choose(cell.color)"></button>
      </div>
      <label class="machine-palette-saturation">饱和度 <input type="range" min="0" max="100" v-model.number="saturation" :aria-label="`${machine}调色板饱和度`" /><span>{{ saturation }}%</span></label>
      <small>灰色色块为禁用颜色</small>
    </div>
  </div>
</template>
<script setup>
import { computed, ref } from 'vue'
import { machineColorError } from '../../shared/machineColors.mjs'
const props = defineProps({ machine: String, value: String })
const emit = defineEmits(['update:value'])
const open = ref(false), saturation = ref(75)
function hex(h, s, l) {
  s /= 100; l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0') }
  return `#${f(0)}${f(8)}${f(4)}`
}
const cells = computed(() => Array.from({ length: 11 }, (_, row) => Array.from({ length: 24 }, (_, col) => { const color = hex(col * 15, saturation.value, row * 10); return { key: row * 24 + col, color, disabled: Boolean(machineColorError(color)) } })).flat())
function choose(color) { if (!machineColorError(color)) { emit('update:value', color); open.value = false } }
</script>
<style scoped>
.machine-palette-trigger { display: inline-flex; gap: 8px; align-items: center; padding: 5px 10px; border: 1px solid var(--line); border-radius: 4px; color: var(--ink); background: var(--page); cursor: pointer; }
.machine-palette.is-open { flex-basis: 100%; }
.machine-palette-trigger > span { width: 18px; height: 18px; border-radius: 3px; border: 1px solid rgba(0,0,0,.15); }
.machine-palette-panel { margin-top: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; width: min(480px, calc(100vw - 120px)); background: var(--page); }
.machine-palette-grid { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); }
.machine-palette-cell { position: relative; width: 100%; aspect-ratio: 1; padding: 0; border: 0; cursor: pointer; }
.machine-palette-cell:focus-visible { outline: 2px solid var(--ink); z-index: 1; }
.machine-palette-cell:disabled { cursor: not-allowed; }
.machine-palette-saturation { display: flex; align-items: center; gap: 8px; margin: 12px 0 6px; font-size: 12px; }
.machine-palette-saturation input { flex: 1; min-width: 0; }
.machine-palette-panel small { color: var(--muted); font-size: 11px; }
</style>
