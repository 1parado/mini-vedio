<script setup lang="ts">
import { MicOff, X } from 'lucide-vue-next'
import { useCall } from '../services/call'

const call = useCall()
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-14 shrink-0 items-center justify-between border-b border-line pr-3 pl-5">
      <h2 class="text-sm font-medium text-ink">
        参与者 <span class="ml-1 text-ink-3">{{ call.participants.length }}</span>
      </h2>
      <button class="icon-btn size-8" aria-label="关闭面板" @click="call.panel = 'none'">
        <X :size="16" />
      </button>
    </div>
    <ul class="flex-1 overflow-y-auto p-3">
      <li
        v-for="p in call.participants"
        :key="p.id"
        class="flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors duration-150 hover:bg-hover"
      >
        <div
          class="flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-white text-xs text-ink-2"
        >
          {{ p.name.charAt(0) }}
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-ink">
            {{ p.name }}<span v-if="p.id === 'self'" class="ml-1 text-xs text-ink-3">（我）</span>
          </p>
          <p class="text-xs text-ink-3">{{ p.connected ? '已连接' : '连接中…' }}</p>
        </div>
        <MicOff v-if="p.id === 'self' && !call.micOn" :size="14" class="shrink-0 text-ink-3" />
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="p.connected ? 'bg-ok' : 'animate-pulse bg-ink-3'"
        ></span>
      </li>
    </ul>
  </div>
</template>
