<template>
  <n-card size="small" :bordered="true">
    <template #header>
      <div>
        <div style="display: flex; align-items: center; gap: 8px; color: var(--ink); font-size: 18px; font-weight: 600;">
          <span>任务执行甘特图</span>
        </div>
        <div class="gantt-caption">按住 Ctrl + 鼠标滚轮可缩放，拖拽任务条可调整时间；点选/拖选顶部时间轴可冻结区间（Esc 或双击本标题栏解除）</div>
      </div>
    </template>
    <template #header-extra>
      <n-space :size="6">
        <n-button size="tiny" tertiary @click="fitTimeline" title="自适应缩放">
          自适应
        </n-button>
        <n-button size="tiny" tertiary @click="resetTimeline" title="重置视图">
          重置
        </n-button>
        <n-button size="tiny" tertiary @click="$emit('manage-hidden')" title="甘特图显示设置与隐藏任务名单">
          设置
        </n-button>
      </n-space>
    </template>
    <div
      ref="viewportRef"
      class="gantt-viewport"
      :style="{ height: `${ganttHeight}px` }"
    >
      <div
        ref="containerRef"
        class="gantt-container"
        :class="{ 'gantt-container-empty': !tasks.length, 'gantt-reference-easter-egg': referenceEasterEgg, 'gantt-sidebar-collapsed': !taskSidebarExpanded }"
        :style="{ '--reference-mantra': JSON.stringify(referenceMantra) }"
      ></div>
      <n-button class="gantt-sidebar-toggle" size="tiny" :aria-expanded="taskSidebarExpanded" :aria-label="taskSidebarExpanded ? '收起任务名称栏' : '展开任务名称栏'" :title="taskSidebarExpanded ? '收起任务名称栏' : '展开任务名称栏'" @click.stop="toggleTaskSidebar">{{ taskSidebarExpanded ? '‹' : '›' }}</n-button>
      <n-empty
        v-if="!tasks.length"
        class="gantt-empty"
        description="暂无符合条件的任务"
      />
    </div>
    <!-- 拖拽时的浮动 tooltip（teleport 到 body，避免被 card overflow 截断） -->
    <Teleport to="body">
      <div
        ref="tooltipRef"
        v-show="dragTip.visible"
        class="gantt-drag-tip"
        :style="{ left: dragTip.x + 'px', top: dragTip.y + 'px' }"
      >
        <div class="gantt-drag-tip-title">{{ dragTip.task }}</div>
        <div class="gantt-drag-tip-bot">
          <span class="gantt-drag-tip-dot" :style="{ background: dragTip.color }"></span>
          {{ dragTip.bot }}
        </div>
        <div class="gantt-drag-tip-owner">
          {{ dragTip.owner }}<span v-if="dragTip.locked"> · 只读</span>
        </div>
        <div v-if="dragTip.runStatus" class="gantt-drag-tip-owner">{{ dragTip.runStatus }}</div>
        <div v-if="dragTip.cron" class="gantt-drag-tip-owner">{{ dragTip.cron }}</div>
        <div class="gantt-drag-tip-time">
          {{ dragTip.start }} <span class="gantt-drag-tip-arrow">→</span> {{ dragTip.finish }}
          <span v-if="dragTip.duration" class="gantt-drag-tip-duration">{{ dragTip.duration }}</span>
          <span v-if="dragTip.crossDay" class="gantt-drag-tip-cross">次日</span>
        </div>
      </div>
    </Teleport>
    <!-- 动态注入每个机器人的颜色 class -->
    <component :is="'style'" v-html="dynamicStyles" />
  </n-card>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Timeline } from 'vis-timeline/standalone'
import { DataSet } from 'vis-data'
import { NCard, NSpace, NButton, NEmpty } from 'naive-ui'
import { taskRunIndicators } from '../../shared/taskRunIndicators.mjs'
import { readDisplayPreference, saveDisplayPreference } from '../services/browserPreferences.js'
import { taskNameOffset } from '../services/taskNameLayout.js'
import { cronTemplateSegments, cronTemplateSummary } from '../../shared/yingdaoCron.mjs'
import { sourceTask, candidateExecutionText } from '../../shared/scheduleDispatch.mjs'
import {
  parseTimeToDate,
  getBotColor,
  getTaskFrequencyBadge,
  DUMMY_DATE,
  DEFAULT_TIMELINE_WINDOW_MS,
  getCurrentTimeWindow,
  isCrossDay,
  formatDuration,
} from '../services/dataService.js'

const props = defineProps({
  tasks: { type: Array, required: true },
  autoScroll: { type: Boolean, default: () => readDisplayPreference('pytaskgantt.timelineAutoScroll') },
  showTaskNames: { type: Boolean, default: false },
  showCurrentTimeLine: { type: Boolean, default: false },
  showReferenceLines: { type: Boolean, default: true },
  showRunStatus: { type: Boolean, default: false },
  runStatus: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['task-click', 'task-update', 'manage-hidden'])

const taskSidebarExpanded = ref(!props.showTaskNames)
async function refreshTaskSidebar() {
  await nextTick()
  if (!timeline) return
  timeline.redraw?.()
  updateData()
  handleRangeChange()
}
function toggleTaskSidebar() { taskSidebarExpanded.value = !taskSidebarExpanded.value; void refreshTaskSidebar() }


const AUTO_SCROLL_COOKIE = 'pytaskgantt.timelineAutoScroll'
const autoScroll = computed(() => props.autoScroll)
function saveAutoScroll() {
  saveDisplayPreference(AUTO_SCROLL_COOKIE, autoScroll.value)
}
watch(autoScroll, () => {
  if (autoScroll.value) {
    resetTimeline()
  }
  else {
    if (initialFocusRaf != null) cancelAnimationFrame(initialFocusRaf)
    initialFocusRaf = null
  }
})

const viewportRef = ref(null)
const containerRef = ref(null)
const ganttHeight = ref(320)
let timeline = null
let itemsDataset = null
let groupsDataset = null
let containerResizeObserver = null
let resizeRaf = null
let initialFocusRaf = null
const MIN_GANTT_HEIGHT = 320
const VIEWPORT_BOTTOM_GAP = 36
const REFERENCE_TIME_ID = 'schedule-reference'
const EVENING_REFERENCE_TIME_ID = 'schedule-reference-evening'
let referenceLinesAdded = false
function configureReferenceLines() {
  if (!timeline) return
  if (props.showReferenceLines && !referenceLinesAdded) {
    timeline.addCustomTime(new Date(`${DUMMY_DATE}T08:30:00`), REFERENCE_TIME_ID)
    timeline.setCustomTimeTitle('', REFERENCE_TIME_ID)
    timeline.addCustomTime(new Date(`${DUMMY_DATE}T17:30:00`), EVENING_REFERENCE_TIME_ID)
    timeline.setCustomTimeTitle('', EVENING_REFERENCE_TIME_ID)
    referenceLinesAdded = true
  } else if (!props.showReferenceLines && referenceLinesAdded) {
    timeline.removeCustomTime(REFERENCE_TIME_ID)
    timeline.removeCustomTime(EVENING_REFERENCE_TIME_ID)
    referenceLinesAdded = false
  }
}
const CURRENT_TIME_ID = 'schedule-current'
let currentTimeTimer = null
let currentTimeLineAdded = false
function currentDisplayTime() {
  const { start, end } = getCurrentTimeWindow()
  return new Date((start.getTime() + end.getTime()) / 2)
}
function configureCurrentTimeLine() {
  clearInterval(currentTimeTimer)
  currentTimeTimer = null
  if (!timeline) return
  if (!props.showCurrentTimeLine) {
    if (currentTimeLineAdded) timeline.removeCustomTime(CURRENT_TIME_ID)
    currentTimeLineAdded = false
    return
  }
  if (!currentTimeLineAdded) {
    timeline.addCustomTime(currentDisplayTime(), CURRENT_TIME_ID)
    timeline.setCustomTimeTitle('', CURRENT_TIME_ID)
    currentTimeLineAdded = true
  }
  currentTimeTimer = setInterval(() => {
    if (timeline && currentTimeLineAdded) timeline.setCustomTime(currentDisplayTime(), CURRENT_TIME_ID)
  }, 1000)
}
const MIN_ZOOM_WINDOW_MS = 1000 * 60 * 5
const referenceEasterEgg = ref(false)
const REFERENCE_MANTRA = '佛祖保佑不异常无bug · 南无阿弥陀佛 · 唵嘛呢叭咪吽 · '
// 按图表高度补足重复文字，超出参考线的部分由样式裁切。
const referenceMantra = computed(() => REFERENCE_MANTRA.repeat(
  Math.ceil(ganttHeight.value / REFERENCE_MANTRA.length) + 1
))
// 拖拽自身触发的 task-update 会导致父组件 allTasks 变化 → 触发本组件 watch。
// 我们已在 onMove 里同步了 dataset，无需再 updateData，这里用一次性标志位跳过。
let suppressNextUpdate = false
// vis-timeline 拖拽 mouseup 后还会触发一次 click，这里用 justDragged 时间窗抑制误弹编辑器
let justDragged = false
// 拖拽中标志：拖拽时由 onMoving 控制 tooltip，hover 事件不能干扰
let isDragging = false

// 自渲染 tooltip 状态（统一用于 hover 与拖拽，浏览器原生 title 已禁用）
const dragTip = ref({
  visible: false,
  x: 0,
  y: 0,
  task: '',
  bot: '',
  color: 'var(--accent)',
  start: '',
  finish: '',
  duration: '',
  crossDay: false,
  owner: '',
  locked: false,
})
const tooltipRef = ref(null)

// 最近鼠标坐标（拖拽边缘自动滚动用）
let lastClientX = 0
let lastClientY = 0

// ===== 时间轴冻结 / 高亮 =====
// 触发区域仅限顶部时间轴刻度栏（.vis-time-axis）：
//   - 两次单击：第一次定冻结开始，第二次定冻结结束（开始晚于结束则自动交换）
//   - 按住拖动：拖选冻结区间，实时预览
// 解冻：点击甘特图外区域 / 按 Esc
// 冻结期间：禁背景横向平移（moveable=false）、autoScroll 挂起、数据刷新保持垂直滚动位
const freezeBand = ref(null) // 已定稿区间 { start: Date, end: Date }，null=未冻结
let pendingClickStart = null // 第一次单击记下的起点（Date），等待第二次单击
let previewBand = null       // 拖选/待确认时的预览区间 { start: Date, end: Date }
let axisGesture = null       // 时间轴手势 { downTime: Date, dragging: boolean }
const FREEZE_BAND_ID = 'freeze-band'

// 时间轴元素（顶部刻度栏），clientX↔时间映射、刻度遍历都基于它的几何范围
// 注意必须用它而不是 containerRef：左侧 220px 标签栏不算在时间范围内
function getAxisEl() {
  if (!containerRef.value) return null
  return containerRef.value.querySelector('.vis-panel.vis-top .vis-time-axis')
    || containerRef.value.querySelector('.vis-time-axis')
}

// 屏幕 clientX → 虚拟时间：按刻度栏自身的 left/width 线性插值
function clientXToTime(clientX) {
  const axis = getAxisEl()
  if (!timeline || !axis) return null
  const rect = axis.getBoundingClientRect()
  if (!rect.width) return null
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  const win = timeline.getWindow()
  return new Date(win.start.getTime() + ratio * (win.end.getTime() - win.start.getTime()))
}

// 当前应显示的区间（优先定稿，其次预览）
function currentBand() {
  return freezeBand.value || previewBand
}

// —— 时间轴上的高亮层 ——
// 不走 vis 的刻度 DOM（重绘时会被回收复用，且 vis 没有 redraw 事件），
// 而是往 .vis-panel.vis-top 里 append 我们自己的绝对定位覆盖层，按视窗百分比定位，
// vis 重绘不会动它；视窗变化时靠 rangechange/rangechanged 事件重算位置。
let axisOverlayEl = null     // 覆盖整个时间轴的容器
let axisOverlayBandEl = null // 高亮块（冻结区间）
let cardHeaderEl = null      // n-card 头部元素（双击解冻用）

function ensureAxisOverlay() {
  if (axisOverlayEl || !containerRef.value) return
  const topPanel = containerRef.value.querySelector('.vis-panel.vis-top')
  if (!topPanel) return
  axisOverlayEl = document.createElement('div')
  axisOverlayEl.className = 'freeze-axis-overlay'
  axisOverlayBandEl = document.createElement('div')
  axisOverlayBandEl.className = 'freeze-axis-band'
  axisOverlayEl.appendChild(axisOverlayBandEl)
  topPanel.appendChild(axisOverlayEl)
}

function updateAxisOverlay() {
  ensureAxisOverlay()
  if (!axisOverlayEl || !axisOverlayBandEl || !timeline || !containerRef.value) return
  const band = currentBand()
  if (!band) {
    axisOverlayBandEl.style.display = 'none'
    return
  }
  axisOverlayBandEl.classList.toggle('freeze-preview', !freezeBand.value)
  // 直接镜像图表区冻结带的实际渲染位置，保证时间轴高亮和图表色带的虚线严格对齐。
  // （不能按"视窗百分比 × 顶部面板宽"换算：vis 内部换算基准是 center 面板宽，
  //   垂直滚动条等因素会让两个宽度不一致，越靠右偏差越大）
  const apply = () => {
    if (!containerRef.value || !axisOverlayBandEl) return
    const bandEl = containerRef.value.querySelector('.vis-item.freeze-band')
    const topPanel = containerRef.value.querySelector('.vis-panel.vis-top')
    if (!bandEl || !topPanel) {
      axisOverlayBandEl.style.display = 'none'
      return
    }
    const b = bandEl.getBoundingClientRect()
    const t = topPanel.getBoundingClientRect()
    axisOverlayBandEl.style.display = 'block'
    axisOverlayBandEl.style.left = `${b.left - t.left}px`
    axisOverlayBandEl.style.width = `${Math.max(b.width, 2)}px`
  }
  // vis 的数据更新/视窗变化是 rAF 节流重绘的，等它画完再量；保险起见量两帧
  requestAnimationFrame(() => {
    apply()
    requestAnimationFrame(apply)
  })
}

// —— 冻结点的竖线标记（vis 官方 custom time marker，贯穿整个图表区） ——
const PENDING_MARKER_ID = 'freeze-pending'

function renderPendingMarker() {
  if (!timeline) return
  try { timeline.removeCustomTime(PENDING_MARKER_ID) } catch { /* 不存在则忽略 */ }
  // 两种情况显示竖线：第一次单击后的待定锚点 / 已定稿的零宽点冻结
  const fb = freezeBand.value
  const pointTime = pendingClickStart || (fb && fb.start.getTime() === fb.end.getTime() ? fb.start : null)
  if (pointTime) timeline.addCustomTime(pointTime, PENDING_MARKER_ID)
}

// 写入/更新/移除冻结带 background item（定稿与预览用不同 className 区分样式）
function renderBandItem() {
  if (!itemsDataset) return
  const band = currentBand()
  if (!band) {
    try { itemsDataset.remove(FREEZE_BAND_ID) } catch { /* 已删 */ }
    updateAxisOverlay()
    return
  }
  const s = band.start.getTime() <= band.end.getTime() ? band.start : band.end
  const e = band.start.getTime() <= band.end.getTime() ? band.end : band.start
  const item = {
    id: FREEZE_BAND_ID,
    start: s,
    end: e,
    type: 'background',
    className: freezeBand.value ? 'freeze-band' : 'freeze-band freeze-preview',
  }
  if (itemsDataset.get(FREEZE_BAND_ID)) itemsDataset.update(item)
  else itemsDataset.add(item)
  updateAxisOverlay()
}

// 冻结定稿：记录区间并锁横向平移
function applyFreeze(start, end) {
  const s = start.getTime() <= end.getTime() ? start : end
  const e = start.getTime() <= end.getTime() ? end : start
  freezeBand.value = { start: s, end: e }
  previewBand = null
  pendingClickStart = null
  timeline?.setOptions({ moveable: false })
  renderBandItem()
  renderPendingMarker()
}

// 解冻 / 清除待定状态：恢复背景平移
function unfreeze() {
  freezeBand.value = null
  previewBand = null
  pendingClickStart = null
  axisGesture = null
  timeline?.setOptions({ moveable: true })
  renderBandItem()
  renderPendingMarker()
}

// —— 手势处理 ——
// capture 阶段捕获时间轴上的 pointerdown：stopPropagation 让 vis 内部 hammer 收不到该手势，
// 避免拖选区间时同时触发背景平移
function onAxisPointerDown(e) {
  if (!timeline || !containerRef.value) return
  if (!e.target.closest('.vis-time-axis')) return
  const time = clientXToTime(e.clientX)
  if (!time) return
  e.preventDefault()
  e.stopPropagation()
  axisGesture = { downTime: time, dragging: false }
}

function onAxisPointerMove(e) {
  if (!axisGesture) return
  const time = clientXToTime(e.clientX)
  if (!time) return
  if (!axisGesture.dragging) {
    // 位移超过 30 秒才判定为拖动，否则视为单击
    if (Math.abs(time.getTime() - axisGesture.downTime.getTime()) < 30000) return
    axisGesture.dragging = true
    // 拖动视为重新选区：清掉已有点冻结/待定锚点，让预览生效
    freezeBand.value = null
    pendingClickStart = null
    renderPendingMarker()
  }
  previewBand = { start: axisGesture.downTime, end: time }
  renderBandItem()
}

function onAxisPointerUp(e) {
  if (!axisGesture) return
  const gesture = axisGesture
  axisGesture = null
  const time = clientXToTime(e.clientX) || gesture.downTime
  if (gesture.dragging) {
    applyFreeze(gesture.downTime, time)
    return
  }
  // 单击逻辑：
  //   - 已有区间冻结 → 忽略（解冻走 Esc / 双击卡片标题栏）
  //   - 已有点冻结（锚点还在）→ 本次单击把点扩展为区间（先后自动交换）
  //   - 否则 → 冻结该时间点：竖线标记 + 视图锁定，记下锚点等待可能的第二次单击
  const fb = freezeBand.value
  if (fb && fb.start.getTime() !== fb.end.getTime()) return
  if (fb && pendingClickStart) {
    applyFreeze(pendingClickStart, time)
    return
  }
  applyFreeze(time, time)
  pendingClickStart = time
  renderPendingMarker()
}

function onFreezeKeyDown(e) {
  if (e.key !== 'Escape') return
  if (!freezeBand.value && !previewBand && !pendingClickStart) return
  e.stopPropagation()
  unfreeze()
}

// 双击甘特图卡片头部（n-card-header）→ 解冻
function onHeaderDblClick() {
  if (!currentBand() && !pendingClickStart) return
  unfreeze()
}

// 鼠标移动始终更新坐标（即使 visible=false 也更新，避免显示瞬间 tooltip 出现在 (0,0)）
// 关键：用 pointermove + capture phase 监听
// 原因：vis-timeline 内部的 hammer.js 拖拽时会对元素 setPointerCapture，
// 此时浏览器只继续派发 pointer events，兼容性的 mousemove 可能被吞掉，
// 所以必须监听 pointermove 才能在拖拽中持续拿到光标坐标。
function onWindowMouseMove(e) {
  lastClientX = e.clientX
  lastClientY = e.clientY
  // 偏移 14/18px 避免遮住光标和被光标 hover 拦截
  dragTip.value.x = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - (tooltipRef.value?.offsetWidth || 320) - 8))
  dragTip.value.y = Math.max(8, Math.min(e.clientY + 18, window.innerHeight - (tooltipRef.value?.offsetHeight || 120) - 8))
}

// ===== 拖拽到边缘自动平移视窗 =====
let autoScrollRaf = null
// 当前正在拖拽的 item id（用于 tickAutoScroll 同步推任务条）
let draggingItemId = null

// 把视窗平移 move ms 时，同步推进 vis-timeline 内部的「拖拽基线时间」。
// vis 内部计算公式：itemData.start = touchParams.itemProps[i].data.start + (toTime(光标X) - toTime(initialX))。
// 因为 toTime 用当前 window，两次 toTime 都加上相同 move，offset 对窗口平移不敏感。
// 不推进基线的话，光标只要轻微抖动 vis 就会用旧基线把任务条写回旧时间，造成「向反方向瞬移」。
function advanceDragBaseline(move) {
  const itemSet = timeline && timeline.itemSet
  const props = itemSet && itemSet.touchParams && itemSet.touchParams.itemProps
  if (!props) return
  for (const p of props) {
    if (!p || !p.data) continue
    if (p.data.start != null) {
      const s = p.data.start instanceof Date ? p.data.start : new Date(p.data.start)
      p.data.start = new Date(s.getTime() + move)
    }
    if (p.data.end != null) {
      const e = p.data.end instanceof Date ? p.data.end : new Date(p.data.end)
      p.data.end = new Date(e.getTime() + move)
    }
  }
}

function tickAutoScroll() {
  // 冻结期间挂起 autoScroll：拖任务到边缘不再平移视窗，避免时间轴跑偏
  if (!isDragging || !timeline || !containerRef.value || freezeBand.value) {
    autoScrollRaf = null
    return
  }
  const rect = containerRef.value.getBoundingClientRect()
  const EDGE = 150 // 触发自动滚动的边缘距离 (px) —— 提前预估，光标还没贴边就开始
  const distLeft = lastClientX - rect.left
  const distRight = rect.right - lastClientX

  let dir = 0
  if (distLeft < EDGE) {
    dir = -(EDGE - distLeft) / EDGE // -1..0，越靠左越快
  } else if (distRight < EDGE) {
    dir = (EDGE - distRight) / EDGE // 0..1，越靠右越快
  }

  if (dir !== 0) {
    const win = timeline.getWindow()
    const range = win.end.getTime() - win.start.getTime()
    const move = range * 0.018 * dir // 每帧移动当前可视范围的 ~1.8% × 强度

    // ★ 三步顺序：①推进 vis 内部拖拽基线 ②同步 dataset（停止抖动时也跟随窗口）③平移视窗
    // 顺序反了的话 setWindow 会先 redraw 旧时间的任务条，视觉上出现反向瞬移。
    advanceDragBaseline(move)
    if (draggingItemId != null && itemsDataset) {
      // 关键：必须从 timeline.itemSet.items[id].data 读「拖拽位移后的实时位置」，
      // 不能用 itemsDataset.get() —— dataset 在拖拽期间一直保持原始时间，
      // 用 dataset 的旧值 + move 写回时，vis 的 _updateItem→setData 会把已拖拽的位移擦掉。
      // 表现：左抓时拖拽位移很大，瞬移就很明显；右抓时位移小，几乎察觉不到。
      const liveItem = timeline.itemSet && timeline.itemSet.items[draggingItemId]
      if (liveItem && liveItem.data && liveItem.data.start) {
        const ls = liveItem.data.start instanceof Date ? liveItem.data.start : new Date(liveItem.data.start)
        const le = liveItem.data.end
          ? (liveItem.data.end instanceof Date ? liveItem.data.end : new Date(liveItem.data.end))
          : null
        const newStart = new Date(ls.getTime() + move)
        const newEnd = le ? new Date(le.getTime() + move) : null
        itemsDataset.update({ id: draggingItemId, start: newStart, end: newEnd })
        // _raw 仍从 dataset 取（dataset 上挂着原始 task 对象）
        const dsEntry = itemsDataset.get(draggingItemId)
        if (dsEntry && dsEntry._raw) {
          showTipFromTask(
            dsEntry._raw,
            formatTime(newStart),
            formatTime(newEnd || newStart)
          )
        }
      }
    }

    timeline.setWindow(
      win.start.getTime() + move,
      win.end.getTime() + move,
      { animation: false }
    )
  }
  autoScrollRaf = requestAnimationFrame(tickAutoScroll)
}

function startAutoScroll() {
  if (autoScrollRaf == null) {
    autoScrollRaf = requestAnimationFrame(tickAutoScroll)
  }
}

function stopAutoScroll() {
  if (autoScrollRaf != null) {
    cancelAnimationFrame(autoScrollRaf)
    autoScrollRaf = null
  }
}

function showTipFromTask(task, startStr, finishStr) {
  dragTip.value.runStatus = ''
  dragTip.value.task = task.task
  dragTip.value.bot = task.bot
  dragTip.value.color = taskColor(task)
  dragTip.value.start = startStr
  dragTip.value.finish = finishStr
  dragTip.value.duration = formatDuration(startStr, finishStr)
  dragTip.value.cron = task.timing_mode === 'cron'
    ? `${task.schedule_cron_expression || '规则待同步'} · 单次预计 ${task.expected_duration_seconds || 60} 秒` : ''
  dragTip.value.crossDay = isCrossDay(startStr, finishStr)
  dragTip.value.owner = task.owner?.display_name || '历史任务'
  dragTip.value.locked = !task.can_edit
  const candidates = candidateExecutionText(task)
  if (candidates) dragTip.value.cron = [dragTip.value.cron, candidates].filter(Boolean).join(' · ')
  dragTip.value.visible = true
  void nextTick(() => { if (tooltipRef.value && dragTip.value.visible) onWindowMouseMove({ clientX: lastClientX, clientY: lastClientY }) })
}

function hideTip() {
  dragTip.value.visible = false
}

function taskColor(task) {
  return task?.color || getBotColor(task?.bot)
}

// 甘特图始终填满当前视口剩余高度。使用容器的真实 top 计算，而不是写死头部高度，
// 因而导航换行、侧栏移动到上方以及浏览器缩放时都能得到正确高度。
function resizeTimelineToViewport() {
  if (!viewportRef.value) return
  if (resizeRaf != null) cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null
    if (!viewportRef.value) return
    const viewportHeight = window.visualViewport?.height || window.innerHeight
    const viewportTop = viewportRef.value.getBoundingClientRect().top
    const maxHeight = Math.max(
      MIN_GANTT_HEIGHT,
      Math.floor(viewportHeight - VIEWPORT_BOTTOM_GAP * 2),
    )
    const availableHeight = Math.floor(
      viewportHeight - viewportTop - VIEWPORT_BOTTOM_GAP,
    )
    const nextHeight = Math.min(
      maxHeight,
      Math.max(MIN_GANTT_HEIGHT, availableHeight),
    )
    if (ganttHeight.value !== nextHeight) ganttHeight.value = nextHeight
    nextTick(() => { timeline?.redraw?.(); scheduleTaskNamePaint() })
  })
}

function resizeTimelineOnScroll() {
  const isStackedLayout = typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 1100px)').matches
    : window.innerWidth <= 1100
  if (isStackedLayout) resizeTimelineToViewport()
}

// 把 bot 名称转为合法的 CSS class 名（处理中文）
function botClassName(bot) {
  // 用 base64 (URL-safe) 保证唯一性 + 合法字符
  const safe = encodeURIComponent(bot).replace(/[^a-zA-Z0-9]/g, '_')
  return `bot-${safe}`
}

const botColors = computed(() => {
  return new Map(props.tasks.map(task => [task.bot, taskColor(task)]))
})

// 动态生成每个 bot 的颜色 CSS
const dynamicStyles = computed(() => {
  return [...botColors.value.entries()]
    .map(([bot, color]) => {
      const cls = botClassName(bot)
      return `
.vis-item.${cls} {
  background-color: ${color};
  border-color: ${color};
  color: #ffffff;
}
.vis-item.${cls}.vis-selected {
  background-color: ${color};
  border-color: ${color};
}
.vis-item.${cls}.task-locked {
  opacity: .58;
  cursor: not-allowed;
  background-image: repeating-linear-gradient(135deg, rgba(255,255,255,0.1) 0 5px, rgba(255,255,255,0.3) 5px 8px);
}
`
    })
    .join('\n')
})

// 任务 → vis-timeline items（每个任务独占一行，group 用 task.id）
// 注意：不再写 title 字段，统一用自渲染 tooltip 显示，避免浏览器原生 tooltip 干扰
const nameSourceItems = new Map()
let taskNameRaf = null
function scheduleTaskNamePaint() {
  if (!props.showTaskNames || taskNameRaf != null) return
  taskNameRaf = requestAnimationFrame(() => {
    taskNameRaf = null
    if (!timeline || !itemsDataset || !props.showTaskNames) return
    const labels = [], removed = []
    for (const [id, source] of nameSourceItems) {
      const painted = withTaskName(source.items, source.task)
      const label = painted[painted.length - 1]
      if (label?._task_name_label) labels.push(label)
      else if (itemsDataset.get(`${id}:task-name`)) removed.push(`${id}:task-name`)
    }
    // Finish all layout reads before writing labels to avoid reflow for every task.
    if (removed.length) itemsDataset.remove(removed)
    if (labels.length) itemsDataset.update(labels)
  })
}
// Non-interactive name paint follows the first visible occurrence, after its badge.
function withTaskName(items, task) {
  nameSourceItems.set(task.view_id || task.id, { items, task })
  if (!props.showTaskNames || !items.length) return items
  const viewport = timeline?.getWindow() || { start: new Date(`${DUMMY_DATE}T00:00:00`), end: new Date(new Date(`${DUMMY_DATE}T00:00:00`).getTime() + DEFAULT_TIMELINE_WINDOW_MS) }
  const left = viewport.start.getTime(), right = viewport.end.getTime()
  const anchor = items.map(item => ({ item, start: Math.max(left, item.start.getTime()), end: Math.min(right, item.end.getTime()) })).find(item => item.end >= item.start)
  if (!anchor) return items
  const name = document.createElement('span')
  name.className = 'gantt-task-name-text'
  name.textContent = task.task
  const badgeVisible = anchor.item.start.getTime() >= left
  const panel = containerRef.value?.querySelector('.vis-panel.vis-center')
  const panelWidth = panel?.clientWidth || 0
  const bounds = panel?.getBoundingClientRect() || { left: 0, right: 0 }
  const anchorX = panelWidth ? (anchor.start - left) / (right - left) * panelWidth : 0
  const content = timeline?.itemSet?.items?.[anchor.item.id]?.dom?.content
  const offset = taskNameOffset(content, bounds.left + anchorX, bounds, badgeVisible ? anchor.item.content : '')
  if (panelWidth > 0) {
    name.style.maxWidth = `${Math.max(1, Math.min(320, window.innerWidth * .45, panelWidth - anchorX - offset - 4))}px`
  }
  name.style.transform = `translateX(${offset}px)`
  return [...items, { id: `${task.view_id || task.id}:task-name`, group: task.view_id || task.id,
    type: 'point', start: new Date(anchor.start), content: name,
    editable: false, className: `gantt-task-name-overlay${task.shared_candidate ? ' shared-name' : ''}`, _task_name_label: true }]
}

function buildItems(tasks) {
  nameSourceItems.clear()
  return tasks.flatMap(t => {
    const { start, end } = parseTimeToDate(t.start, t.finish)
    const freq = getTaskFrequencyBadge(t.tags, t.timing_mode)
    const classes = [botClassName(t.bot)]
    const indicator = props.showRunStatus ? taskRunIndicators(t, props.runStatus) : null
    if (indicator) classes.push('with-run-strip')
    const runFields = (first, last) => {
      if (!indicator) return {}
      const result = indicator(first, last)
      return { style: `--run-status-strip: ${result.background};`, _run_hint: result.hint }
    }
    if (t._preview_modified) classes.push('task-preview-modified')
    const viewId = t.view_id || t.id
    if (t.shared_candidate) classes.push('shared-candidate')
    // 历史任务保持 task-locked（最淡）；仅含周/月的非历史任务淡化（浓于历史任务）
    if (!t.can_edit) classes.push('task-locked')
    else if (freq.faded) classes.push('freq-faded')
    if (t.timing_mode === 'cron') {
      const win = timeline?.getWindow()
      const range = win ? win.end.getTime() - win.start.getTime() : DEFAULT_TIMELINE_WINDOW_MS
      const bucket = Math.max(60, Math.ceil(range / 1000 / 120 / 60) * 60)
      const base = new Date(`${DUMMY_DATE}T00:00:00`).getTime()
      try {
        return withTaskName(cronTemplateSegments(t.schedule_cron_expression, t.expected_duration_seconds || 60, bucket).map(segment => ({
          id: `${viewId}:cron:${segment.start}`, group: viewId,
          start: new Date(base + segment.start * 1000), end: new Date(base + segment.end * 1000),
          content: segment.count > 1 ? `🔁 ×${segment.count}` : '<span class="freq-badge">🔁</span>',
          editable: false, className: [...classes, 'cron-occurrence', segment.count > 1 ? 'cron-aggregate' : ''].join(' '),
          _raw: t, _cron_count: segment.count, ...runFields(segment.start, segment.last),
        })), t)
      } catch { return [] }
    }
    return withTaskName([{
      id: viewId,
      group: viewId,
      content: freq.badge ? `<span class="freq-badge">${freq.badge}</span>` : '', // 左侧周期 emoji
      start,
      end,
      editable: t.can_edit && !t.shared_candidate ? { updateTime: true, updateGroup: false, remove: false } : false,
      className: classes.join(' '),
      _raw: t, ...runFields(),
    }], t)
  })
}

// 任务 → vis-timeline groups（每个任务一行，label 显示任务名 + 机器人色块）
// 行序直接沿用父组件传入的 tasks 顺序——排序的唯一事实源是 App.vue 的 filterTasks(sortBy)。
// 不在这里二次排序，否则「按时间 / 按机器人」切换对甘特图不生效。
const SVG_NS = 'http://www.w3.org/2000/svg'

function createLockIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-label', '只读')
  const body = document.createElementNS(SVG_NS, 'rect')
  Object.entries({ x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }).forEach(([k, v]) => body.setAttribute(k, v))
  const shackle = document.createElementNS(SVG_NS, 'path')
  shackle.setAttribute('d', 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2')
  for (const el of [body, shackle]) {
    el.setAttribute('stroke', 'currentColor')
    el.setAttribute('stroke-width', '1.4')
    svg.appendChild(el)
  }
  return svg
}

// 左侧轨道标签：机器人色条 + 任务名 + 所有者（只读任务带锁图标）。
// 传 DOM 元素而非 HTML 字符串：vis-timeline 会用 xss 过滤字符串内容，剥掉 class 和 svg。
function buildGroupLabel(t) {
  const ownerName = t.owner?.display_name || '历史任务'
  const row = document.createElement('div')
  row.className = t.can_edit ? 'gantt-label-row' : 'gantt-label-row is-locked'
  row.title = `${t.task} · ${t.bot} · ${ownerName}${t.timing_mode === 'cron' ? ` · ${cronTemplateSummary(t.schedule_cron_expression, t.expected_duration_seconds || 60)}` : ''}`
  if (candidateExecutionText(t)) row.title += ` · ${candidateExecutionText(t)}`

  const dot = document.createElement('span')
  dot.className = 'gantt-label-dot'
  dot.style.background = taskColor(t)

  const name = document.createElement('span')
  name.className = 'gantt-label-name'
  name.textContent = `${t.shared_candidate ? `${t.bot} · 候选 · ` : ''}${t.timing_mode === 'cron' ? '🔁 ' : ''}${t.task}${t.timing_mode === 'cron' && !t.schedule_cron_expression ? '（规则待同步）' : ''}`

  const owner = document.createElement('span')
  owner.className = 'gantt-label-owner'
  if (!t.can_edit) owner.appendChild(createLockIcon())
  const ownerText = document.createElement('span')
  ownerText.className = 'gantt-label-owner-name'
  ownerText.textContent = t.owner?.display_name || '历史'
  owner.appendChild(ownerText)

  row.append(dot, name, owner)
  return row
}

function buildGroups(tasks) {
  return tasks.map((t, idx) => ({
    id: t.view_id || t.id,
    order: idx, // 配合 timeline option `groupOrder: 'order'` 控制行序
    content: buildGroupLabel(t),
    className: `${botClassName(t.bot)}${t.shared_candidate ? ' shared-candidate-label' : ''}`,
    _bot: t.bot,
    _start: t.start,
  }))
}

function createTimeline() {
  if (!containerRef.value) return

  itemsDataset = new DataSet(buildItems(props.tasks))
  groupsDataset = new DataSet(buildGroups(props.tasks))
  const dayStart = new Date(`${DUMMY_DATE}T00:00:00`)

  const options = {
    stack: false,
    editable: {
      add: false,
      updateTime: true,
      updateGroup: false,
      remove: false,
      overrideItems: false,
    },
    zoomable: true,
    moveable: true,
    orientation: 'top',
    showCurrentTime: false,
    margin: { item: { vertical: 4, horizontal: 0 }, axis: 8 },
    verticalScroll: true,
    zoomKey: 'ctrlKey', // 防止误缩放，按住 Ctrl 才能滚轮缩放
    height: '100%',
    groupHeightMode: 'fixed',
    groupOrder: 'order',
    // 凌晨居中时左侧需要延伸到前一天，避免被 vis 的边界钳制。
    min: new Date(dayStart.getTime() - DEFAULT_TIMELINE_WINDOW_MS / 2),
    max: new Date('2025-01-02T23:59:59'),
    start: dayStart,
    end: new Date(dayStart.getTime() + DEFAULT_TIMELINE_WINDOW_MS),
    zoomMin: MIN_ZOOM_WINDOW_MS, // 5 分钟
    zoomMax: 1000 * 60 * 60 * 30, // 30 小时
    format: {
      minorLabels: { minute: 'HH:mm', hour: 'HH:mm' },
      majorLabels: { hour: '', day: '' },
    },
    onMoving: (item, callback) => {
      // 拖拽过程中实时刷新自渲染 tooltip
      const raw = item._raw
      if (!raw?.can_edit || raw.timing_mode === 'cron' || raw.shared_candidate) {
        callback(null)
        return
      }
      if (raw) {
        if (!isDragging) {
          isDragging = true
          draggingItemId = item.id
          startAutoScroll() // 开始边缘自动滚动监测
        }
        // 注意：自动滚动产生的视窗平移已经通过 advanceDragBaseline 写回到 vis 内部基线，
        // 所以这里收到的 item.start/end 已经是含「视窗平移 + 光标 delta」的最终值，无需补偿。
        const newStart = formatTime(item.start)
        const newFinish = formatTime(item.end || new Date(item.start.getTime() + 30 * 60 * 1000))
        showTipFromTask(raw, newStart, newFinish)
      }
      callback(item)
    },
    onMove: (item, callback) => {
      if (!item._raw?.can_edit || item._raw.timing_mode === 'cron' || item._raw.shared_candidate) {
        callback(null)
        return
      }
      // 拖拽完成回调：vis-timeline 内部已经把新位置（含视窗平移）写到了 dataset 里。
      // 我们 emit 通知父组件更新数据源，但要抑制父组件回流引发的整体重建。
      const newStart = formatTime(item.start)
      const newFinish = formatTime(item.end || new Date(item.start.getTime() + 30 * 60 * 1000))
      callback(item)
      // 隐藏 tooltip + 清拖拽态 + 停掉自动滚动 + 清拖拽 id
      isDragging = false
      draggingItemId = null
      stopAutoScroll()
      hideTip()
      suppressNextUpdate = true
      // 抑制 mouseup 后紧跟的 click 事件，避免拖完就弹编辑器
      justDragged = true
      setTimeout(() => { justDragged = false }, 250)
      emit('task-update', {
        id: item.id,
        start: newStart,
        finish: newFinish,
      })
    },
  }

  timeline = new Timeline(containerRef.value, itemsDataset, groupsDataset, options)
  scheduleTaskNamePaint()
  configureReferenceLines()
  configureCurrentTimeLine()

  // 视窗变化（缩放/平移）后按新区间重算时间轴高亮层位置
  // 注意：vis-timeline 没有 redraw 事件，rangechange/rangechanged 是公开 API 里覆盖视窗变化的事件
  timeline.on('rangechange', () => { handleRangeChange(); scheduleTaskNamePaint() })
  timeline.on('rangechanged', () => {
    handleRangeChange()
    if (props.showTaskNames || props.tasks.some(task => task.timing_mode === 'cron')) updateData()
  })

  // 单击：触发编辑
  timeline.on('click', props_evt => {
    if (justDragged) return // 刚结束拖拽的 click 是误触，不弹编辑器
    if (props_evt.item != null && props_evt.what === 'item') {
      const item = itemsDataset.get(props_evt.item)
      if (item && item._raw) {
        // _raw 是 buildItems 时的原始引用，时间可能已被拖拽更新过；
        // 这里从 dataset 拿到最新 start/end 重新组装，避免回填旧时间。
        const latest = {
          ...sourceTask(item._raw),
          ...(item._raw.timing_mode === 'cron' || item._raw.shared_candidate ? {} : {
            start: formatTime(item.start), finish: formatTime(item.end || item.start),
          }),
        }
        emit('task-click', latest)
      }
    }
  })

  // Hover：进入 item 显示 tooltip
  timeline.on('itemover', evt => {
    if (isDragging) return // 拖拽中由 onMoving 控制，不要被 hover 抢
    if (evt.item == null) return
    const item = itemsDataset.get(evt.item)
    if (!item || !item._raw) return
    showTipFromTask(
      item._raw,
      formatTime(item.start),
      formatTime(item.end || item.start)
    )
    if (props.showRunStatus) dragTip.value.runStatus = item._run_hint || ''
    if (item._cron_count > 1) dragTip.value.cron += ` · 此段汇总 ${item._cron_count} 次计划`
  })

  // Hover：离开 item 隐藏（拖拽中可能短暂离开 item 区域，此时不要隐藏）
  timeline.on('itemout', () => {
    if (isDragging) return
    hideTip()
  })

  // 先让起始视窗完成一帧绘制，再播放滑向当前时间的动画。
  if (autoScroll.value) initialFocusRaf = requestAnimationFrame(() => {
    initialFocusRaf = requestAnimationFrame(() => {
      initialFocusRaf = null
      if (autoScroll.value) resetTimeline()
    })
  })
}

function handleRangeChange() {
  if (!timeline) return
  updateAxisOverlay()
  const { start, end } = timeline.getWindow()
  // vis 的时间窗口可能存在毫秒取整误差；仅在最大放大倍率显示彩蛋。
  referenceEasterEgg.value = end.getTime() - start.getTime() <= MIN_ZOOM_WINDOW_MS + 1
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

// 差异化同步 dataset：
// - 删除新数据里没有的 id
// - update 已存在的 id（属性变了会触发重绘，没变就保留）
// - 新增的 id 由 update 自动追加
// 避免 clear()+add() 整体重建造成的闪烁。
function syncDataset(dataset, nextRows) {
  const oldIds = dataset.getIds()
  const nextIds = new Set(nextRows.map(r => r.id))
  const toRemove = oldIds.filter(id => !nextIds.has(id))
  if (toRemove.length) dataset.remove(toRemove)
  dataset.update(nextRows)
}

function updateData() {
  if (!timeline || !itemsDataset || !groupsDataset) return
  // 保存垂直滚动位：syncDataset 重建行后 vis 会回顶，这里恢复，避免轮询刷新跳到顶部
  const itemset = containerRef.value?.querySelector('.vis-itemset')
  const savedTop = itemset ? itemset.scrollTop : null
  syncDataset(groupsDataset, buildGroups(props.tasks))
  syncDataset(itemsDataset, buildItems(props.tasks))
  scheduleTaskNamePaint()
  // syncDataset 会把不在 buildItems 里的冻结带删掉，这里按当前状态补回/清除
  renderBandItem()
  if (savedTop != null && itemset) itemset.scrollTop = savedTop
}

function fitTimeline() {
  timeline?.fit({ animation: { duration: 300 } })
}

function resetTimeline() {
  if (!timeline) return
  if (initialFocusRaf != null) cancelAnimationFrame(initialFocusRaf)
  initialFocusRaf = null
  const { start, end } = getCurrentTimeWindow()
  timeline.setWindow(
    start,
    end,
    { animation: { duration: 1200, easingFunction: 'easeInOutQuad' } }
  )
}

watch(
  () => props.tasks,
  async () => {
    await nextTick()
    if (!timeline) {
      createTimeline()
      return
    }
    // 拖拽自身触发的数据回流：vis 已经显示了新位置，跳过一次同步避免重排闪烁
    if (suppressNextUpdate) {
      suppressNextUpdate = false
      // 拖动位置已经更新，仍需同步预览标识和原任务，保证红框立即出现。
      for (const item of buildItems(props.tasks)) {
        if (itemsDataset.get(item.id)) itemsDataset.update(item._task_name_label ? item : { id: item.id, className: item.className, _raw: item._raw })
      }
      return
    }
    updateData()
    timeline.redraw?.()
  },
  { deep: true }
)

watch([() => props.showRunStatus, () => props.runStatus], () => { updateData(); timeline?.redraw?.() }, { deep: true })
watch(() => props.showCurrentTimeLine, configureCurrentTimeLine)
watch(() => props.showReferenceLines, configureReferenceLines)

watch(() => props.showTaskNames, enabled => { taskSidebarExpanded.value = !enabled; updateData(); void refreshTaskSidebar() })

onMounted(() => {
  saveAutoScroll()
  resizeTimelineToViewport()
  createTimeline()
  window.addEventListener('resize', resizeTimelineToViewport, { passive: true })
  window.addEventListener('scroll', resizeTimelineOnScroll, { passive: true })
  window.visualViewport?.addEventListener('resize', resizeTimelineToViewport, { passive: true })
  if (typeof ResizeObserver !== 'undefined') {
    containerResizeObserver = new ResizeObserver(() => {
      resizeTimelineToViewport()
    })
    containerResizeObserver.observe(viewportRef.value)
    const appContent = viewportRef.value.closest('.app-content')
    if (appContent) containerResizeObserver.observe(appContent)
  }
  // pointermove 是关键：拖拽中 hammer.js 会 setPointerCapture，mousemove 被吞，但 pointermove 仍会派发
  // capture: true —— 在 vis-timeline 内部之前先收到事件
  window.addEventListener('pointermove', onWindowMouseMove, { passive: true, capture: true })
  // mousemove 作为非拖拽态的兜底（hover 移动时 pointermove 也会触发，但保留 mousemove 不会有坏处）
  window.addEventListener('mousemove', onWindowMouseMove, { passive: true, capture: true })
  // 拖拽过程中如果 pointerup/mouseup 在 timeline 外或被打断，兜底隐藏 tooltip
  window.addEventListener('pointerup', hideDragTip, { capture: true })
  window.addEventListener('mouseup', hideDragTip, { capture: true })
  window.addEventListener('blur', hideDragTip)
  // 时间轴冻结：capture 捕获刻度栏 pointerdown + window 级 move/up + Esc/双击卡片头解冻
  if (containerRef.value) {
    containerRef.value.addEventListener('pointerdown', onAxisPointerDown, { capture: true })
    // 组件根是 n-card，取它渲染出的 .n-card-header 监听双击
    cardHeaderEl = containerRef.value.closest('.n-card')?.querySelector('.n-card-header') || null
    cardHeaderEl?.addEventListener('dblclick', onHeaderDblClick)
  }
  window.addEventListener('pointermove', onAxisPointerMove, { passive: true })
  window.addEventListener('pointerup', onAxisPointerUp)
  window.addEventListener('keydown', onFreezeKeyDown)
})

function hideDragTip() {
  // 拖拽中（isDragging=true）的 mouseup 由 onMove 处理；非拖拽态的 mouseup/blur 兜底隐藏
  if (!isDragging && dragTip.value.visible) dragTip.value.visible = false
}

onBeforeUnmount(() => {
  clearInterval(currentTimeTimer)
  currentTimeTimer = null
  currentTimeLineAdded = false
  if (taskNameRaf != null) cancelAnimationFrame(taskNameRaf)
  taskNameRaf = null
  nameSourceItems.clear()
  window.removeEventListener('pointermove', onWindowMouseMove, { capture: true })
  window.removeEventListener('mousemove', onWindowMouseMove, { capture: true })
  window.removeEventListener('pointerup', hideDragTip, { capture: true })
  window.removeEventListener('mouseup', hideDragTip, { capture: true })
  window.removeEventListener('blur', hideDragTip)
  if (containerRef.value) {
    containerRef.value.removeEventListener('pointerdown', onAxisPointerDown, { capture: true })
  }
  cardHeaderEl?.removeEventListener('dblclick', onHeaderDblClick)
  cardHeaderEl = null
  window.removeEventListener('pointermove', onAxisPointerMove, { passive: true })
  window.removeEventListener('pointerup', onAxisPointerUp)
  window.removeEventListener('keydown', onFreezeKeyDown)
  window.removeEventListener('resize', resizeTimelineToViewport)
  window.removeEventListener('scroll', resizeTimelineOnScroll)
  window.visualViewport?.removeEventListener('resize', resizeTimelineToViewport)
  containerResizeObserver?.disconnect()
  containerResizeObserver = null
  if (resizeRaf != null) cancelAnimationFrame(resizeRaf)
  resizeRaf = null
  if (initialFocusRaf != null) cancelAnimationFrame(initialFocusRaf)
  initialFocusRaf = null
  stopAutoScroll()
  if (timeline) {
    timeline.destroy()
    timeline = null
  }
  axisOverlayEl = null
  axisOverlayBandEl = null
})
</script>

<style scoped>
/* Keep label heights measurable while letting vis recalculate the left gutter to zero. */
.gantt-sidebar-collapsed :deep(.vis-panel.vis-left) { width: 0 !important; min-width: 0 !important; max-width: 0 !important; overflow: hidden !important; border-right: 0 !important; }
.gantt-sidebar-collapsed :deep(.vis-labelset), .gantt-sidebar-collapsed :deep(.vis-labelset .vis-label) { width: 0 !important; min-width: 0 !important; max-width: 0 !important; overflow: hidden; }
.gantt-container :deep(.vis-item.with-run-strip::after) { content: ''; position: absolute; inset: 0; background: var(--run-status-strip, #9ca3af); border-radius: inherit; clip-path: inset(calc(100% - 4px) 0 0); pointer-events: none; z-index: 1; }
.gantt-sidebar-toggle { position: absolute; top: 5px; left: 4px; z-index: 12; width: 22px; background: var(--page, #fff); font-size: 20px; }
.gantt-container :deep(.vis-item.gantt-task-name-overlay) { background: transparent !important; border: 0 !important; pointer-events: none !important; z-index: 5; top: calc(50% - 10px) !important; box-shadow: none !important; overflow: visible; color: var(--ink, #24352a); font-size: 11px; }
.gantt-container :deep(.gantt-task-name-overlay .vis-dot) { display: none; }
.gantt-container :deep(.gantt-task-name-overlay .vis-item-content) { margin: 0 !important; padding: 0 !important; width: max-content !important; pointer-events: none; }
.gantt-container :deep(.gantt-task-name-text) { display: block; max-width: min(320px, 45vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 18px; padding: 0 4px; border-radius: 0; background: transparent; text-shadow: 0 0 2px #fff, 1px 0 #fff, -1px 0 #fff, 0 1px #fff, 0 -1px #fff; font-weight: 500; pointer-events: none; }
.gantt-container :deep(.gantt-task-name-overlay.shared-name) { opacity: .75; }
.gantt-container :deep(.vis-item.cron-occurrence) { min-width: 3px; }
.gantt-container :deep(.vis-item.cron-aggregate) { background-image: repeating-linear-gradient(135deg, transparent 0 5px, rgba(255,255,255,.25) 5px 8px); }
.gantt-viewport {
  position: relative;
  width: 100%;
  min-height: 320px;
}

.gantt-container {
  width: 100%;
  height: 100%;
}

.gantt-container-empty {
  visibility: hidden;
  pointer-events: none;
}

.gantt-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>

<style>
/* 自渲染拖拽 tooltip —— teleport 到 body，不能用 scoped */
.gantt-drag-tip {
  max-width: min(520px, calc(100vw - 32px));
  overflow-wrap: anywhere;
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  min-width: 160px;
  padding: 8px 12px;
  background: #29382F;
  color: #ffffff;
  border-radius: 6px;
  box-shadow: 0 6px 16px rgba(41, 56, 47, 0.18);
  font-size: 12px;
  line-height: 1.6;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(4px);
}
.gantt-drag-tip-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
  color: #ffffff;
}
.gantt-drag-tip-bot {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgba(255,255,255,0.75);
  font-size: 11px;
}
.gantt-drag-tip-owner {
  color: rgba(255,255,255,0.62);
  font-size: 11px;
}
.gantt-drag-tip-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.gantt-drag-tip-time {
  margin-top: 4px;
  font-family: "SF Mono", "Fira Code", Consolas, monospace;
  font-size: 12px;
  color: #ffffff;
}
.gantt-drag-tip-arrow {
  margin: 0 2px;
  color: rgba(255,255,255,0.6);
}
.gantt-drag-tip-cross {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  background: var(--warn);
  color: #ffffff;
  border-radius: 3px;
  font-size: 10px;
  font-family: inherit;
}
.gantt-drag-tip-duration {
  display: inline-block;
  margin-left: 8px;
  padding: 0 6px;
  background: rgba(255,255,255,0.18);
  color: rgba(255,255,255,0.92);
  border-radius: 3px;
  font-size: 11px;
  font-family: inherit;
  font-weight: 500;
}
</style>

<style>
/* 全局样式：限制 vis-timeline 左侧轨道标签宽度 */
.vis-labelset .vis-label {
  width: 220px;
  min-width: 220px;
  max-width: 260px;
  padding: 0;
}
.vis-labelset .vis-label .vis-inner {
  padding: 0;
  width: 100%;
  overflow: hidden;
}
.vis-timeline .vis-panel.vis-left {
  border-right: 1px solid var(--line);
}
/* 行高紧凑一些 */
.vis-foreground .vis-group {
  border-bottom: 1px solid var(--line-soft);
}
/* 任务条垂直居中：
   stack:false 时 vis 把每个任务条钉在 top = margin.item.vertical(4px)，而行高(31px)由更高的
   左侧标签撑起，导致任务条偏上、底部留白(4px/7px)。
   item 的 top 相对其所属 .vis-group 容器（高度=行高），用 50% 取行中线，再减去任务条自身高度的一半
   按任务条公共高度减去一半，保持加高后的任务条在轨道中间。!important 覆盖 vis 写入的内联 top。
   （不用 translateY(-50%)：vis-item 上的 transform 会被内部样式覆盖而失效。） */
.vis-foreground .vis-item.vis-range {
  top: calc(50% - var(--gantt-task-height, 26px) / 2) !important;
}
/* 周期 emoji：任务条左侧、垂直居中。
   注意 vis 的 .vis-item.vis-range .vis-item-content 是 position:relative + padding:5px，
   绝对定位会相对这个比任务条更高的内容盒居中（视觉上偏下）；
   所以直接把内容盒改成 flex 满高 + align-items 居中，emoji 用静态定位 */
.vis-item.vis-range .vis-item-content {
  display: flex !important;
  align-items: center !important;
  height: 100% !important;
  padding: 0 6px !important;
}
.vis-item .freq-badge {
  font-size: 16px;
  line-height: 1;
  letter-spacing: 1px;
  pointer-events: none;
  user-select: none;
  color: #ffffff;
  text-shadow: 0 1px 2px var(--faint);
}
/* 仅含每周/每月（不含每日）的非历史任务淡化：opacity .78，介于历史任务(.58)和正常(1)之间 */
.vis-item.freq-faded {
  opacity: .78;
}
/* 时间轴冻结高亮带（图表区）：半透明色块 + 两侧虚线；零宽（单击第一次）时靠 border 显示竖线 */
.vis-item.freeze-band {
  background-color: rgba(0, 127, 50, 0.12) !important;
  border-left: 2px dashed rgba(0, 127, 50, 0.7) !important;
  border-right: 2px dashed rgba(0, 127, 50, 0.7) !important;
  box-sizing: border-box;
  pointer-events: none;
}
/* 拖选/待定中的预览态：比定稿更淡 */
.vis-item.freeze-band.freeze-preview {
  background-color: rgba(0, 127, 50, 0.07) !important;
  border-color: rgba(0, 127, 50, 0.45) !important;
}
/* 时间轴上的高亮覆盖层：我们自己的 DOM（append 到 .vis-panel.vis-top），
   vis 重绘不会动它，位置按视窗百分比由 updateAxisOverlay 维护 */
.vis-panel.vis-top .freeze-axis-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 10;
  overflow: hidden;
}
.freeze-axis-band {
  position: absolute;
  top: 0;
  bottom: 0;
  display: none;
  background-color: rgba(0, 127, 50, 0.28);
  border-left: 2px dashed rgba(0, 127, 50, 0.85);
  border-right: 2px dashed rgba(0, 127, 50, 0.85);
  box-sizing: border-box;
}
.freeze-axis-band.freeze-preview {
  background-color: rgba(0, 127, 50, 0.14);
  border-color: rgba(0, 127, 50, 0.5);
}
/* 第一次单击后的待定竖线（贯穿图表区）；禁 pointer-events 防止被用户拖动 */
.vis-custom-time.freeze-pending {
  background-color: rgba(0, 127, 50, 0.85) !important;
  width: 2px !important;
  pointer-events: none !important;
}
/* 固定排班参考线；与冻结标记独立，不参与鼠标交互。 */
.gantt-container .vis-custom-time:is(.schedule-reference, .schedule-reference-evening) {
  background: repeating-linear-gradient(to bottom, var(--muted) 0 4px, transparent 4px 8px);
  width: 1px;
  pointer-events: none;
}
.gantt-container.gantt-reference-easter-egg .vis-custom-time:is(.schedule-reference, .schedule-reference-evening, .schedule-current) {
  background: none;
}
.gantt-container.gantt-reference-easter-egg .vis-custom-time:is(.schedule-reference, .schedule-reference-evening, .schedule-current)::after {
  content: var(--reference-mantra);
  position: absolute;
  top: 48px;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  writing-mode: vertical-rl;
  text-orientation: upright;
  white-space: nowrap;
  font-size: 8px;
  width: 1em;
  overflow: hidden;
  line-height: 1;
  letter-spacing: 1px;
  color: var(--timeline-line-color, var(--muted));
  pointer-events: none;
}
.gantt-container .vis-custom-time:is(.schedule-reference, .schedule-reference-evening, .schedule-current) * {
  pointer-events: none;
}
</style>

<style>
.gantt-container .vis-custom-time.schedule-current { --timeline-line-color: #008c45; background: repeating-linear-gradient(to bottom, var(--timeline-line-color) 0 4px, transparent 4px 8px); width: 1px; pointer-events: none; }
</style>
