<script setup lang="ts">
import { computed } from 'vue'
import { Check, Lock } from 'lucide-vue-next'
import { useCall } from '../services/call'

const call = useCall()
const show = computed(
  () => call.phase !== 'idle' || !call.micOn || !call.camOn || !!call.notice,
)
</script>

<template>
  <div v-if="show" class="flex items-center gap-2">
    <div
      v-if="call.phase === 'connecting'"
      class="flex h-8 items-center gap-2 rounded-full bg-black/40 px-3.5 text-xs text-white/90"
    >
      <span class="size-1.5 animate-pulse rounded-full bg-white/70"></span>正在连接…
    </div>
    <div
      v-else-if="call.phase === 'connected'"
      class="flex h-8 items-center gap-2 rounded-full bg-black/40 px-3.5 text-xs text-white/90"
    >
      <span class="size-1.5 rounded-full bg-ok"></span>已连接
    </div>
    <div
      v-else-if="call.phase === 'failed'"
      class="flex h-8 items-center gap-2 rounded-full bg-black/40 px-3.5 text-xs text-red-300"
    >
      连接失败<span v-if="call.phaseDetail" class="text-white/50">· {{ call.phaseDetail }}</span>
    </div>
    <button
      v-if="call.phase === 'connected' && call.sasCode"
      :title="'与对方核对这串代码，一致即可确认端到端加密未被窃听（防中间人）'"
      class="flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition-colors duration-150"
      :class="call.sasVerified ? 'bg-ok/90 text-white' : 'bg-black/40 text-white/90 hover:bg-black/60'"
      @click="call.sasVerified = !call.sasVerified"
    >
      <Lock v-if="!call.sasVerified" :size="11" />
      <Check v-else :size="11" />
      {{ call.sasCode }}
    </button>
    <div
      v-if="call.notice"
      class="flex h-8 items-center rounded-full bg-black/40 px-3.5 text-xs text-white/80"
    >
      {{ call.notice }}
    </div>
    <div
      v-if="!call.micOn"
      class="flex h-8 items-center rounded-full bg-black/40 px-3.5 text-xs text-white/70"
    >
      麦克风已关闭
    </div>
    <div
      v-if="!call.camOn"
      class="flex h-8 items-center rounded-full bg-black/40 px-3.5 text-xs text-white/70"
    >
      摄像头已关闭
    </div>
  </div>
</template>
