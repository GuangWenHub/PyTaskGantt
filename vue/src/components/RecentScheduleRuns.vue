<template>
  <section class="recent-runs" aria-label="最近10次无重试成功运行记录" :aria-busy="loading">
    <p v-if="scheduledRunSummary" class="scheduled-run-summary">{{ scheduledRunSummary }}</p>
    <section v-if="latest" class="latest-run" aria-label="最近一次运行（所有触发方式）">
      <header class="latest-run-header">
        <strong>最近一次运行</strong><span class="latest-run-source">所有触发方式</span>
        <n-button v-if="canRetry && latestState === 'error' && !retryAccepted" size="small"
          type="warning" secondary :loading="retrying" :disabled="retryDisabled || retrying" @click="emit('retry', latest)">
          重试
        </n-button>
        <span v-if="retryAccepted" role="status">重试已受理</span>
      </header>
      <div class="run-heading">
        <span>{{ latest.normalized_status }}</span><strong>{{ duration(latest.duration_seconds) }}</strong>
      </div>
      <div class="run-bar-track" role="img" :aria-label="latest.normalized_status">
        <div class="run-bar" :style="{ backgroundColor: colors[latestState], width: latestWidth }" />
      </div>
      <div class="run-times">
        <span v-if="latest.trigger_time">触发 {{ formatRunDateTime(latest.trigger_time) }}</span>
        <span v-if="latest.start_time">开始 {{ formatRunDateTime(latest.start_time) }}</span>
        <span>结束 {{ formatRunDateTime(latest.end_time) }}</span>
      </div>
    </section>
    <header><strong>最近10次运行 · 无重试成功</strong><span v-if="result?.sample_count" class="run-statistics"><span>最大运行时间 {{ duration(result.max_duration_seconds) }}</span><span>最小运行时间 {{ duration(result.min_duration_seconds) }}</span><span>平均耗时 {{ duration(result.average_duration_seconds) }}</span></span><span v-else>暂无可用耗时统计</span></header>
    <p v-if="loading" role="status">正在读取运行记录…</p>
    <p v-else-if="error" role="alert">运行记录读取失败：{{ error }}</p>
    <p v-else-if="!bound">选择计划后显示最近10次无重试、无异常的成功记录。</p>
    <p v-else-if="!result?.records?.length">暂无已核验的无重试成功记录。</p>
    <ol v-else>
      <li v-for="(run, index) in result.records" :key="run.task_uuid">
        <div class="run-heading"><span>#{{ index + 1 }} · {{ run.status_name }}</span><strong>{{ duration(run.duration_seconds) }}</strong></div>
        <div class="run-bar-track" role="img" :aria-label="`${run.status_name}，总耗时 ${duration(run.duration_seconds)}`"><div v-if="run.duration_seconds !== null" class="run-bar" :style="{ width: `${Math.max(2, run.duration_seconds / maxDuration * 100)}%` }"></div></div>
        <div class="run-times"><span>开始 {{ formatRunDateTime(run.start_time) }}</span><span>结束 {{ formatRunDateTime(run.end_time) }}</span></div>
      </li>
    </ol>
    <p v-if="!loading && !error && result?.verification_failed_count" role="alert">{{ result.verification_failed_count }} 条运行记录核验失败，请稍后重试。当前统计仅供参考，不自动填写耗时；也可手动确认耗时。</p>
    <small v-if="bound && !loading && !error">仅统计无重试、无异常且起止时间有效的成功执行；最多核对最近200条记录，不足10条时按已核验记录统计。</small>
  </section>
</template>
<script setup>
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { formatRunDateTime } from '../services/dataService.js'
import { formatElapsedTime as duration } from '../../shared/scheduleAutofill.mjs'
import { RUN_STATUS_COLORS as colors } from '../../shared/runStatusColors.mjs'
import { stateOf } from '../../shared/taskRunIndicators.mjs'
const props = defineProps({ result: { type: Object, default: null }, loading: Boolean, error: String, bound: Boolean,
  scheduledRunSummary: { type: String, default: '' }, canRetry: Boolean, retrying: Boolean, retryAccepted: Boolean, retryDisabled: Boolean })
const emit = defineEmits(['retry'])
const maxDuration = computed(() => Math.max(1, ...(props.result?.records || []).map(run => run.duration_seconds || 0)))
const latest = computed(() => props.result?.latest_run)
const latestState = computed(() => stateOf(latest.value?.normalized_status))
const latestWidth = computed(() => {
  const seconds = latest.value?.duration_seconds
  return seconds == null ? '100%' : `${Math.max(2, Math.min(100, seconds / maxDuration.value * 100))}%`
})
</script>
<style scoped>
.recent-runs { min-width: 0; margin-top: 8px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--warm); }
.recent-runs header { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline; }
.scheduled-run-summary { margin: 0 0 10px; }
.latest-run-source { margin-right: auto; }
.latest-run { margin-bottom: 16px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; }
.recent-runs .latest-run-header { justify-content: space-between; align-items: center; margin-bottom: 6px; }
.run-statistics { display: flex; flex-wrap: wrap; gap: 6px 16px; font-variant-numeric: tabular-nums; }
.recent-runs header span, .recent-runs small, .recent-runs p, .run-times { font-size: 12px; color: var(--muted); }
.recent-runs ol { list-style: none; padding: 0; margin: 14px 0; display: grid; gap: 14px; }
.recent-runs li { min-width: 0; }
.run-heading, .run-times { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; overflow-wrap: anywhere; }
.run-heading { font-size: 12px; }
.run-bar-track { margin: 5px 0; height: 10px; background: var(--line-soft); border-radius: 3px; overflow: hidden; }
.run-bar { height: 100%; background: var(--accent); border-radius: 3px; }
</style>
