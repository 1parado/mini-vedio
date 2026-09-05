<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import type { CallRecord } from '../types'
import { clearCallRecords, listCallRecords, statusLabel } from '../services/history'

const records = ref<CallRecord[]>([])

function refresh(): void {
  records.value = listCallRecords()
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes ? `${minutes}分${remainder.toString().padStart(2, '0')}秒` : `${remainder}秒`
}

function clear(): void {
  clearCallRecords()
  refresh()
}

onMounted(refresh)
</script>

<template>
  <section class="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-8">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-lg font-semibold text-ink">通话记录</h1>
        <p class="mt-1 text-xs text-ink-3">记录仅保存在本机浏览器存储中</p>
      </div>
      <button v-if="records.length" class="icon-btn size-9" title="清空记录" aria-label="清空记录" @click="clear">
        <Trash2 :size="16" />
      </button>
    </div>
    <div v-if="!records.length" class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p class="text-sm text-ink-2">暂无通话记录</p>
      <p class="text-xs text-ink-3">结束一通通话后会显示在这里</p>
    </div>
    <ul v-else class="mt-6 divide-y divide-line overflow-y-auto rounded-xl border border-line">
      <li v-for="record in records" :key="record.id" class="flex items-center gap-3 px-4 py-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-hover text-sm text-ink-2">
          {{ record.peerName.charAt(0) || '对' }}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-ink">{{ record.peerName }}</p>
          <p class="mt-0.5 text-xs text-ink-3">{{ formatTime(record.startedAt) }} · {{ formatDuration(record.durationSec) }}</p>
        </div>
        <span class="text-xs" :class="record.status === 'completed' ? 'text-ok' : 'text-danger'">
          {{ statusLabel(record.status) }}
        </span>
      </li>
    </ul>
  </section>
</template>
