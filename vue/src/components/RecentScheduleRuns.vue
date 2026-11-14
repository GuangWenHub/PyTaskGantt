<template>
  <section class="recent-runs" aria-label="最近10次无重试成功运行记录" :aria-busy="loading">
    <header><strong>最近10次运行 · 无重试成功</strong><span v-if="result?.sample_count" class="run-statistics"><span>最大运行时间 {{ duration(result.max_duration_seconds) }}</span><span>最小运行时间 {{ duration(result.min_duration_seconds) }}</span><span>平均耗时 {{ duration(result.average_duration_seconds) }}</span></span><span v-else>暂无可用耗时统计</span></header>
    <p v-if="loading" role="status">正在读取运行记录…</p>
    <p v-else-if="error" role="alert">运行记录读取失败：{{ error }}</p>
    <p v-else-if="!bound">选择计划后显示最近10次无重试、无异常的成功记录。</p>
    <p v-else-if="!result?.records?.length">暂无已核验的无重试成功记录。</p>
    <ol v-else>
      <li v-for="(run, index) in result.records" :key="run.task_uuid">
        <div class="run-heading"><span>#{{ index + 1 }} · {{ run.status_name }}</span><strong>{{ duration(run.duration_seconds) }}</strong></div>
        <div class="run-bar-track" role="img" :aria-label="`${run.status_name}，总耗时 ${duration(run.duration_seconds)}`"><div v-if="run.duration_seconds !== null" class="run-bar" :style="{ width: `${Math.max(2, run.duration_seconds / maxDuration * 100)}%` }"></div></div>
        <div class="run-times"><span>开始 {{ formatDateTime(run.start_time) }}</span><span>结束 {{ formatDateTime(run.end_time) }}</span></div>
      </li>
    </ol>
    <p v-if="!loading && !error && result?.verification_failed_count" role="alert">{{ result.verification_failed_count }} 条运行记录核验失败，请稍后重试。当前统计仅供参考，不自动填写耗时；也可手动确认耗时。</p>
    <small v-if="bound && !loading && !error">仅统计无重试、无异常且起止时间有效的成功执行；最多核对最近200条记录，不足10条时按已核验记录统计。</small>
  </section>
</template>
<script setup>
import { computed } from 'vue'
import { formatDateTime } from '../services/dataService.js'
import { formatElapsedTime as duration } from '../../shared/scheduleAutofill.mjs'
const props = defineProps({ result: { type: Object, default: null }, loading: Boolean, error: String, bound: Boolean })
const maxDuration = computed(() => Math.max(1, ...(props.result?.records || []).map(run => run.duration_seconds || 0)))
</script>
<style scoped>
.recent-runs { min-width: 0; margin-top: 8px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--warm); }
.recent-runs header { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline; }
.run-statistics { display: flex; flex-wrap: wrap; gap: 6px 16px; font-variant-numeric: tabular-nums; }
.recent-runs header span, .recent-runs small, .recent-runs p, .run-times { font-size: 12px; color: var(--muted); }
.recent-runs ol { list-style: none; padding: 0; margin: 14px 0; display: grid; gap: 14px; }
.recent-runs li { min-width: 0; }
.run-heading, .run-times { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; overflow-wrap: anywhere; }
.run-heading { font-size: 12px; }
.run-bar-track { margin: 5px 0; height: 10px; background: var(--line-soft); border-radius: 3px; overflow: hidden; }
.run-bar { height: 100%; background: var(--accent); border-radius: 3px; }
</style>
