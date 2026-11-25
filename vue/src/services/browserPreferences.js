// Display preferences are browser-wide; authentication cookies remain server-managed.
import { machineColorError } from '../../shared/machineColors.mjs'
export const DISPLAY_PREFERENCES = {
  'pytaskgantt.showTaskNames': true,
  'pytaskgantt.showHiddenTasks': false,
  'pytaskgantt.showRunStatus': false,
  'pytaskgantt.showCurrentTimeLine': false,
  'pytaskgantt.showReferenceLines': true,
  'pytaskgantt.timelineAutoScroll': false,
}
export function readDisplayPreference(key) {
  try {
    const parts = document.cookie.split(';').map(part => part.trim())
    const value = parts.find(part => part.startsWith(`${key}=`)) || (key === 'pytaskgantt.showReferenceLines' ? parts.find(part => part.startsWith('pytaskgantt.showEarlyReferenceLine='))?.replace('showEarlyReferenceLine=', 'showReferenceLines=') : undefined)
    return value === `${key}=1` ? true : value === `${key}=0` ? false : Boolean(DISPLAY_PREFERENCES[key])
  } catch { return Boolean(DISPLAY_PREFERENCES[key]) }
}
export function saveDisplayPreference(key, value) {
  if (!(key in DISPLAY_PREFERENCES)) return
  try { document.cookie = `${key}=${value ? '1' : '0'}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}` } catch { /* Keep the in-page setting usable when cookies are blocked. */ }
}
export function renewDisplayPreferences() {
  for (const key of Object.keys(DISPLAY_PREFERENCES)) saveDisplayPreference(key, readDisplayPreference(key))
  for (const [name, color] of Object.entries(readMachineColorCookies())) writeMachineColorCookie(name, color)
}

export const MACHINE_COLOR_COOKIE_PREFIX = 'pytaskgantt.machineColor.'
export function readMachineColorCookies() {
  const result = Object.create(null)
  try {
    for (const part of document.cookie.split(';')) {
      const [key, value] = part.trim().split('=')
      if (!key.startsWith(MACHINE_COLOR_COOKIE_PREFIX) || !/^#[0-9a-f]{6}$/i.test('#' + value)) continue
      try { if (!machineColorError('#' + value)) result[decodeURIComponent(key.slice(MACHINE_COLOR_COOKIE_PREFIX.length))] = '#' + value } catch {}
    }
  } catch {}
  return result
}
export function writeMachineColorCookie(name, color) {
  try { document.cookie = `${MACHINE_COLOR_COOKIE_PREFIX}${encodeURIComponent(name)}=${color ? color.slice(1) : ''}; Max-Age=${color ? 31536000 : 0}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}` } catch {}
}
