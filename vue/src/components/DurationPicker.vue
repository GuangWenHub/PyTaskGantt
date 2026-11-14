<template>
  <n-popover v-model:show="show" trigger="manual" placement="bottom" to="body" :flip="true" :disabled="disabled" @clickoutside="closeOutside">
    <template #trigger><div ref="rootRef" class="duration-picker" @click="openEditor" @keydown.esc.stop.prevent="show = false">
      <input ref="inputRef" :value="text" :aria-label="label" inputmode="numeric" placeholder="HH:MM:SS" :disabled="disabled" @focus="openEditor" @input="text = $event.target.value" @change="commit" @keydown.enter.prevent="commit" />
      <button type="button" :disabled="disabled" :aria-label="`滑条选择${label}`" :aria-expanded="show" @mousedown.prevent><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 6v6l4 2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
    </div></template>
    <div class="duration-sliders" @keydown.esc.stop.prevent="show = false">
      <label v-for="(unit, index) in units" :key="unit"><span>{{ unit }} {{ parts[index] }}</span><input type="range" :aria-label="`${label}${unit}`" :min="0" :max="index === 0 ? Math.floor(max / 3600) : 59" :step="index === 1 ? 'any' : 1" :value="index === 1 && minutePosition !== null ? minutePosition : parts[index]" @input="slide(index, Number($event.target.value))" @pointerup="minutePosition = null" @pointercancel="minutePosition = null" @blur="minutePosition = null" @keydown="rangeKey(index, $event)" /></label>
    </div>
  </n-popover>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { NPopover } from 'naive-ui'
import { formatElapsedTime } from '../../shared/scheduleAutofill.mjs'
const props = defineProps({ value: { type: Number, default: 0 }, min: { type: Number, default: 0 }, max: { type: Number, default: 86399 }, disabled: Boolean, label: { type: String, default: '耗时' } })
const emit = defineEmits(['update:value'])
const text = ref('')
const show = ref(false), inputRef = ref(null), rootRef = ref(null), minutePosition = ref(null)
const units = ['时', '分', '秒']
const parts = computed(() => [Math.floor((props.value || 0) / 3600), Math.floor((props.value || 0) % 3600 / 60), (props.value || 0) % 60])
watch(() => props.value, value => { text.value = formatElapsedTime(value) }, { immediate: true })
function openEditor() {
  if (props.disabled) return
  show.value = true
  inputRef.value?.focus()
}
function closeOutside(event) { if (!rootRef.value?.contains(event.target)) show.value = false }
function update(seconds) { if (!props.disabled) emit('update:value', Math.min(props.max, Math.max(props.min, seconds))) }
function slide(index, value) {
  const values = [...parts.value]
  if (index === 1) {
    const anchor = Math.round(value / 5) * 5
    // 仅在刻度两侧0.6分钟内轻微减速，不锁住整段5分钟区间。
    const position = anchor <= 59 && Math.abs(value - anchor) < .6 ? anchor + (value - anchor) * .5 : value
    minutePosition.value = position
    values[index] = Math.max(0, Math.min(59, Math.round(position)))
  } else values[index] = value
  update(values[0] * 3600 + values[1] * 60 + values[2])
}
function rangeKey(index, event) {
  if (index !== 1) return
  const increments = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 }
  if (!(event.key in increments) && !['Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const value = event.key === 'Home' ? 0 : event.key === 'End' ? 59 : Math.max(0, Math.min(59, parts.value[1] + increments[event.key]))
  slide(1, value)
  minutePosition.value = null
}
function commit() {
  if (props.disabled) return
  const match = text.value.match(/^(\d{1,2}):(\d{2}):(\d{2})$/)
  if (match && +match[2] < 60 && +match[3] < 60) {
    const seconds = +match[1] * 3600 + +match[2] * 60 + +match[3]
    if (seconds >= props.min && seconds <= props.max) { text.value = formatElapsedTime(seconds); update(seconds); return }
  }
  text.value = formatElapsedTime(props.value)
}
</script>
<style scoped>
.duration-picker { display: flex; width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 4px; background: white; box-sizing: border-box; height: 34px; overflow: hidden; }
.duration-picker > input { min-width: 0; width: 84px; flex: 1; border: 0; padding: 0 6px; background: transparent; color: var(--accent); font: inherit; text-align: center; font-variant-numeric: tabular-nums; outline: none; }
.duration-picker:focus-within { border-color: var(--accent); }
.duration-picker > button { display: grid; place-items: center; flex-shrink: 0; border: 0; padding: 0 8px; background: transparent; color: var(--muted); cursor: pointer; }
.duration-sliders { width: min(260px, calc(100vw - 64px)); display: grid; gap: 14px; padding: 4px; }
.duration-sliders label { display: grid; grid-template-columns: 44px 1fr; gap: 8px; align-items: center; }
.duration-sliders input { width: 100%; accent-color: var(--accent); }
</style>
