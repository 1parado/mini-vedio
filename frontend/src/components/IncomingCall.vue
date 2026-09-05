<script setup lang="ts">
import { useCall } from '../services/call'

const call = useCall()
</script>

<template>
  <div v-if="call.lanIncoming" class="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6">
    <div class="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-float">
      <div
        class="mx-auto flex size-14 items-center justify-center rounded-full border border-line bg-hover text-lg text-ink-2"
      >
        {{ call.lanIncoming.name.charAt(0) }}
      </div>
      <p class="mt-4 text-sm font-medium text-ink">{{ call.lanIncoming.name }} 邀请你通话</p>
      <p class="mt-1 text-xs text-ink-3">局域网点对点加密通话</p>
      <div class="mt-6 flex items-center justify-center gap-3">
        <button
          class="h-10 rounded-full border border-line px-5 text-sm text-ink-2 transition-colors duration-150 hover:bg-hover"
          @click="call.declineLanCall()"
        >
          拒绝
        </button>
        <button
          class="h-10 rounded-full bg-accent px-6 text-sm text-white transition-colors duration-150 hover:bg-accent-strong"
          @click="call.acceptLanCall()"
        >
          接听
        </button>
      </div>
    </div>
  </div>
</template>
