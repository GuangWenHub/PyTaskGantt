import { ref } from 'vue'
import { readDisplayPreference, saveDisplayPreference } from './browserPreferences.js'
const COOKIE = 'pytaskgantt.showHiddenTasks'
export function useHiddenTaskPreference() {
  const enabled = ref(readDisplayPreference(COOKIE))
  function save(value = enabled.value) {
    enabled.value = Boolean(value)
    saveDisplayPreference(COOKIE, enabled.value)
  }
  save()
  return { enabled, save }
}
