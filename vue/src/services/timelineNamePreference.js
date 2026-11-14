import { ref } from 'vue'
import { readDisplayPreference, saveDisplayPreference } from './browserPreferences.js'
const COOKIE = 'pytaskgantt.showTaskNames'
export function useTimelineNamePreference() {
  const enabled = ref(readDisplayPreference(COOKIE))
  function save(value = enabled.value) {
    enabled.value = Boolean(value)
    saveDisplayPreference(COOKIE, enabled.value)
  }
  save()
  return { enabled, save }
}

export function useCurrentTimeLinePreference() {
  const key = 'pytaskgantt.showCurrentTimeLine'
  const enabled = ref(readDisplayPreference(key))
  function save(value = enabled.value) {
    enabled.value = Boolean(value)
    saveDisplayPreference(key, enabled.value)
  }
  save()
  return { enabled, save }
}

export function useReferenceLinesPreference() {
  const key = 'pytaskgantt.showReferenceLines'
  const enabled = ref(readDisplayPreference(key))
  function save(value = enabled.value) {
    enabled.value = Boolean(value)
    saveDisplayPreference(key, enabled.value)
  }
  save()
  return { enabled, save }
}

export function useTimelineAutoScrollPreference() {
  const key = 'pytaskgantt.timelineAutoScroll'
  const enabled = ref(readDisplayPreference(key))
  function save(value = enabled.value) {
    enabled.value = Boolean(value)
    saveDisplayPreference(key, enabled.value)
  }
  save()
  return { enabled, save }
}
