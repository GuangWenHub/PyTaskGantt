import { ref } from 'vue'
const COOKIE = 'pytaskgantt.showSharedTasks'
export function useSharedTaskPreference() {
  const enabled = ref(document.cookie.split(';').some(value => value.trim() === `${COOKIE}=1`))
  function save(value = enabled.value) {
    enabled.value = Boolean(value)
    document.cookie = `${COOKIE}=${enabled.value ? '1' : '0'}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
  }
  save()
  return { enabled, save }
}
