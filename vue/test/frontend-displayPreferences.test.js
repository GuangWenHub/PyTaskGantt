// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { readDisplayPreference, renewDisplayPreferences, DISPLAY_PREFERENCES } from '../src/services/browserPreferences.js'
import { taskNameOffset } from '../src/services/taskNameLayout.js'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('实际登录成功时续期全部显示偏好，并保留人工选择', async () => {
  document.cookie = 'pytaskgantt.showTaskNames=0; Path=/'
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie'), writes = []
  vi.spyOn(document, 'cookie', 'set').mockImplementation(value => { writes.push(value); descriptor.set.call(document, value) })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: true, user: { id: '1' } }), { headers: { 'Content-Type': 'application/json' } })))
  const { switchDevUser } = await import('../src/services/authService.js')
  await switchDevUser('1')
  expect(writes).toHaveLength(Object.keys(DISPLAY_PREFERENCES).length)
  expect(writes.every(value => value.includes('Max-Age=31536000'))).toBe(true)
  expect(readDisplayPreference('pytaskgantt.showTaskNames')).toBe(false)
})
it('登录续期保留每项选择，所有显示Cookie续期一年，默认隐藏关闭', () => {
  document.cookie = 'pytaskgantt.showTaskNames=0; Path=/'
  document.cookie = 'pytaskgantt.showRunStatus=1; Path=/'
  document.cookie = 'pytaskgantt.showHiddenTasks=; Max-Age=0; Path=/'
  const writes = [], descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  vi.spyOn(document, 'cookie', 'set').mockImplementation(value => { writes.push(value); descriptor.set.call(document, value) })
  renewDisplayPreferences()
  expect(writes).toHaveLength(Object.keys(DISPLAY_PREFERENCES).length)
  expect(writes.every(value => value.includes('Max-Age=31536000'))).toBe(true)
  expect(readDisplayPreference('pytaskgantt.showTaskNames')).toBe(false)
  expect(readDisplayPreference('pytaskgantt.showRunStatus')).toBe(true)
  expect(readDisplayPreference('pytaskgantt.showHiddenTasks')).toBe(false)
  document.cookie = 'pytaskgantt.showRunStatus=0; Path=/'
})
it('首次测量前为多个完整emoji预留空间；实际测量采用文字末端而非整条任务宽度', () => {
  expect(taskNameOffset(null, 0, {}, '☀️⭐🌙')).toBeGreaterThan(taskNameOffset(null, 0, {}, '☀️'))
  const content = document.createElement('span'); content.textContent = '☀️⭐🌙'; document.body.append(content)
  vi.spyOn(document, 'createRange').mockReturnValue({ selectNodeContents() {}, getClientRects: () => [{ left: 110, right: 164, width: 54 }] })
  expect(taskNameOffset(content, 100, { left: 100, right: 500 })).toBe(68)
  expect(taskNameOffset(content, 130, { left: 130, right: 500 })).toBe(38)
  expect(taskNameOffset(content, 200, { left: 200, right: 500 })).toBe(4)
  content.remove()
})
