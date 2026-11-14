<template>
  <div class="clock-time-picker">
    <n-popover v-model:show="show" trigger="click" placement="bottom" to="body" :flip="true" :disabled="disabled">
      <template #trigger><button class="clock-trigger" type="button" :disabled="disabled" :aria-label="`表盘选择${label} ${localValue || ''}`" aria-haspopup="dialog" :aria-expanded="show"><span>{{ localValue || '选择时间' }}</span><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 6v6l4 2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></template>
      <div class="clock-panel">
        <div class="clock-dial" :aria-label="`${label}${units[active]}表盘`" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="dragging = false" @lostpointercapture="dragging = false">
          <Transition name="clock-face" mode="out-in">
          <div :key="active" class="clock-face">
          <svg viewBox="0 0 240 240" aria-hidden="true"><line x1="120" y1="120" :x2="hand.x" :y2="hand.y" stroke="currentColor" stroke-width="2"/><circle cx="120" cy="120" r="4" fill="currentColor"/><circle class="clock-hand-knob" :cx="hand.x" :cy="hand.y" r="14" fill="currentColor"/><circle v-if="dragging" :cx="hand.x" :cy="hand.y" r="3" fill="white"/></svg>
          <button v-for="number in numbers" :key="number" type="button" :aria-label="`${number}${units[active]}`" :aria-pressed="parts[active] === number" :style="position(number)" @click="event => { if (event.detail === 0) selectNumber(number) }">{{ String(number).padStart(2, '0') }}</button>
          </div>
          </Transition>
        </div>
        <div class="clock-footer">
          <div class="clock-units"><label v-for="(unit, index) in units" :key="unit" class="clock-unit" :data-active="active === index"><input :value="unitTexts[index]" :aria-label="`${label}${unit}`" :disabled="disabled" inputmode="numeric" maxlength="2" @focus="active = index; $event.target.select()" @input="unitTexts[index] = $event.target.value; emit('edit')" @change="commitUnit(index)" @keydown.enter.prevent="commitUnit(index, true)" /><span>{{ unit }}</span></label></div>
          <button class="clock-done" type="button" @click="commitUnit(active); show = false">完成</button>
        </div>
      </div>
    </n-popover>
  </div>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { NPopover } from 'naive-ui'
const props = defineProps({ value: { type: String, default: '' }, disabled: Boolean, label: { type: String, default: '时间' } })
const emit = defineEmits(['update:value', 'edit'])
const active = ref(1), dragging = ref(false), show = ref(false)
const unitTexts = ref(['00', '00', '00'])
const localValue = ref(props.value || '')
const dragPoint = ref(null)
const units = ['时', '分', '秒']
const parts = computed(() => /^\d{2}:\d{2}:\d{2}$/.test(localValue.value) ? localValue.value.split(':').map(Number) : [0, 0, 0])
watch(() => props.value, value => { localValue.value = value || '' }, { immediate: true })
watch(show, opened => { if (opened) { active.value = 1; dragging.value = false; dragPoint.value = null } })
watch(localValue, () => { unitTexts.value = parts.value.map(n => String(n).padStart(2, '0')) }, { immediate: true })
const numbers = computed(() => Array.from({ length: active.value === 0 ? 24 : 12 }, (_, i) => active.value === 0 ? i : i * 5))
function point(number) {
  const angle = number / (active.value === 0 ? 12 : 60) * Math.PI * 2
  const radius = active.value === 0 && number > 0 && number <= 12 ? 65 : 96
  return { x: 120 + Math.sin(angle) * radius, y: 120 - Math.cos(angle) * radius }
}
function position(number) { const p = point(number); return { left: `${p.x / 2.4}%`, top: `${p.y / 2.4}%` } }
const hand = computed(() => dragging.value && dragPoint.value ? dragPoint.value : point(parts.value[active.value]))
function update(value) { localValue.value = value; emit('update:value', value) }
function choose(number) {
  if (props.disabled) return
  const values = [...parts.value]
  values[active.value] = number
  update(values.map(n => String(n).padStart(2, '0')).join(':'))
}
function selectNumber(number) {
  if (props.disabled) return
  const hourSelected = active.value === 0
  choose(number)
  if (hourSelected) active.value = 1
}
function readPointer(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const x = (event.clientX - rect.left) * 240 / rect.width - 120
  const y = (event.clientY - rect.top) * 240 / rect.height - 120
  const fraction = ((Math.atan2(x, -y) / (Math.PI * 2)) + 1) % 1
  const radius = active.value === 0 && Math.hypot(x, y) < 80 ? 65 : 96
  dragPoint.value = { x: 120 + Math.sin(fraction * Math.PI * 2) * radius, y: 120 - Math.cos(fraction * Math.PI * 2) * radius }
  if (active.value === 0) {
    const hour = Math.round(fraction * 12) % 12
    choose(Math.hypot(x, y) < 80 ? hour || 12 : hour === 0 ? 0 : hour + 12)
  } else choose(Math.round(fraction * 60) % 60)
}
function pointerDown(event) {
  if (props.disabled || (event.button !== undefined && event.button !== 0)) return
  event.preventDefault()
  dragging.value = true
  event.currentTarget.setPointerCapture?.(event.pointerId)
  readPointer(event)
}
function pointerMove(event) { if (dragging.value) readPointer(event) }
function pointerUp(event) {
  if (!dragging.value) return
  readPointer(event)
  const hourSelected = active.value === 0
  dragging.value = false
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  if (hourSelected) active.value = 1
}
function commitUnit(index, advance = false) {
  if (props.disabled) return
  const text = unitTexts.value[index]
  if (/^\d{1,2}$/.test(text) && Number(text) <= (index === 0 ? 23 : 59)) {
    const values = [...parts.value]
    values[index] = Number(text)
    update(values.map(n => String(n).padStart(2, '0')).join(':'))
    unitTexts.value[index] = String(values[index]).padStart(2, '0')
    if (advance && index === 0) active.value = 1
  } else unitTexts.value[index] = String(parts.value[index]).padStart(2, '0')
}
</script>
<style scoped>
.clock-time-picker { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }
.clock-time-picker:focus-within { border-color: var(--accent); }
.clock-trigger { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; min-width: 0; max-width: 100%; height: 34px; box-sizing: border-box; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: white; color: var(--ink); font: inherit; font-size: 13px; cursor: pointer; }
.clock-trigger span { min-width: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
.clock-trigger svg { flex-shrink: 0; color: var(--muted); }
.clock-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.clock-trigger[aria-expanded="true"] { border-color: var(--accent); }
.clock-trigger:disabled { cursor: not-allowed; opacity: .5; }
.clock-panel { width: min(260px, calc(100vw - 64px)); box-sizing: border-box; }
.clock-footer { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.clock-units { display: flex; flex: 1; min-width: 0; gap: 6px; }
.clock-unit { display: flex; flex: 1; min-width: 0; align-items: center; justify-content: center; gap: 3px; padding: 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--warm); color: var(--muted); font-size: 12px; }
.clock-unit input { width: 2ch; min-width: 0; border: 0; padding: 3px 0; outline: none; text-align: center; font-size: 17px; font-variant-numeric: tabular-nums; color: var(--ink); background: transparent; }
.clock-unit[data-active="true"] { color: var(--accent); border-color: var(--accent); }
.clock-unit[data-active="true"] input { color: var(--accent); }
.clock-dial { position: relative; width: 100%; aspect-ratio: 1; border-radius: 50%; background: var(--warm); touch-action: none; user-select: none; cursor: grab; }
.clock-dial:active { cursor: grabbing; }
.clock-face { position: absolute; inset: 0; }
.clock-face-enter-active, .clock-face-leave-active { transition: opacity .12s ease, transform .12s ease; }
.clock-face-enter-from, .clock-face-leave-to { opacity: 0; transform: scale(.97); }
.clock-face-leave-active { pointer-events: none; }
.clock-dial svg { position: absolute; inset: 0; width: 100%; height: 100%; color: var(--accent); pointer-events: none; }
.clock-dial button { position: absolute; transform: translate(-50%, -50%); display: grid; place-items: center; border: 0; border-radius: 50%; width: 26px; height: 26px; padding: 0; background: transparent; font: inherit; font-size: 12px; cursor: pointer; color: var(--ink); }
.clock-dial button[aria-pressed="true"] { color: white; }
.clock-done { flex-shrink: 0; border: 0; border-radius: 4px; padding: 6px 10px; color: white; background: var(--accent); cursor: pointer; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .clock-face-enter-active, .clock-face-leave-active { transition: none; } }
</style>
