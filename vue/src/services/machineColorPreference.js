import { shallowRef, readonly } from 'vue'
import { readMachineColorCookies, writeMachineColorCookie } from './browserPreferences.js'
import { machineColorError, normalizeMachineColor } from '../../shared/machineColors.mjs'
const colors = shallowRef(Object.fromEntries(Object.entries(readMachineColorCookies()).filter(([, color]) => !machineColorError(color))))
export function useMachineColorPreference() {
  function save(name, value) {
    if (machineColorError(value)) return false
    const color = normalizeMachineColor(value)
    colors.value = { ...colors.value, [name]: color }
    writeMachineColorCookie(name, color)
    return true
  }
  function reset(name) {
    const next = { ...colors.value }; delete next[name]; colors.value = next
    writeMachineColorCookie(name, null)
  }
  return { colors: readonly(colors), save, reset }
}
export function applyMachineColors(tasks, customColors) {
  return tasks.map(task => {
    const color = customColors?.[task.bot]
    return color && !machineColorError(color) ? { ...task, color } : task
  })
}
