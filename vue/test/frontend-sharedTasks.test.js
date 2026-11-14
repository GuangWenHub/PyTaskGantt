// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { filterTasks } from '../src/services/dataService.js'
import { normalizeScheduleDispatch, projectSharedTasks, sourceTask } from '../shared/scheduleDispatch.mjs'
import { useSharedTaskPreference } from '../src/services/sharedTaskPreference.js'
import { scheduleCronExpression, cronTemplateSegments } from '../shared/yingdaoCron.mjs'

const clients = [{ uuid: 'a', robotClientName: 'admin@zjkq' }, { uuid: 'b', robotClientName: 'bot_1@zjkq' }, { uuid: 'c', robotClientName: 'caiwu@zjkq' }]
const base = { id: '1', task: '共享任务', bot: '原Bot', start: '09:00:00', finish: '10:00:00', can_edit: true }
const shared = { ...base, schedule_dispatch: normalizeScheduleDispatch({ executeScope: 'any', clientScope: 'assign', robotClientList: clients }) }

describe('共享任务展示', () => {
  it('一份源任务投影到三台候选机器，身份唯一且始终映射回原任务', () => {
    const rows = projectSharedTasks([shared])
    expect(rows.map(row => row.bot)).toEqual(['admin', 'bot_1', 'caiwu'])
    expect(new Set(rows.map(row => row.view_id)).size).toBe(3)
    expect(new Set(rows.map(row => row.id)).size).toBe(1)
    rows.forEach(row => expect(sourceTask(row)).toBe(shared))
  })
  it('开关关闭隐藏共享任务，普通任务保留；候选机器筛选后只留下对应投影', () => {
    const ordinary = { ...base, id: '2', bot: 'admin' }
    expect(filterTasks([shared, ordinary], { showSharedTasks: false }).map(row => row.id)).toEqual(['2'])
    const sources = filterTasks([shared, ordinary], { showSharedTasks: true, selectedBots: ['bot_1'] })
    expect(sources).toHaveLength(1)
    expect(filterTasks(projectSharedTasks(sources), { selectedBots: ['bot_1'], preserveDecoration: true }).map(row => row.bot)).toEqual(['bot_1'])
  })
  it('all 与单候选不按随机共享任务处理；重复机器ID去重，不保存敏感上游字段', () => {
    const dispatch = normalizeScheduleDispatch({ executeScope: 'all', clientScope: 'assign', robotClientList: [...clients, clients[0]], accessToken: 'secret' })
    expect(dispatch.clients).toHaveLength(3)
    expect(JSON.stringify(dispatch)).not.toContain('secret')
    expect(projectSharedTasks([{ ...base, schedule_dispatch: dispatch }])).toHaveLength(1)
    expect(projectSharedTasks([{ ...base, schedule_dispatch: { ...dispatch, execute_scope: 'any', clients: dispatch.clients.slice(0, 1) } }])).toHaveLength(1)
  })
  it('默认关闭，Cookie 长期记忆开关选择并在重新进入后恢复', () => {
    document.cookie = 'pytaskgantt.showSharedTasks=; Max-Age=0; Path=/'
    const preference = useSharedTaskPreference()
    expect(preference.enabled.value).toBe(false)
    preference.save(true)
    expect(useSharedTaskPreference().enabled.value).toBe(true)
    preference.save(false)
    expect(useSharedTaskPreference().enabled.value).toBe(false)
  })
  it('案例的分钟型规则准确生成144次，支持触发分钟偏移，不误转换7分钟间隔', () => {
    const expression = scheduleCronExpression({ type: 'minute', minute: 10, nextTime: '2026-10-26 16:50:00' })
    const segments = cronTemplateSegments(expression, 60)
    expect(segments).toHaveLength(144)
    expect(segments[0].start).toBe(0)
    expect(segments.at(-1).start).toBe(85800)
    expect(cronTemplateSegments(scheduleCronExpression({ type: 'minute', minute: 10, nextTime: '2026-10-26 16:52:00' }))[0].start).toBe(120)
    expect(() => scheduleCronExpression({ type: 'minute', minute: 7, nextTime: '2026-10-26 16:52:00' })).toThrow()
  })
})
