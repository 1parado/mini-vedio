<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { ArrowUp, X } from 'lucide-vue-next'
import { useCall } from '../services/call'

const call = useCall()
const text = ref('')
const listEl = ref<HTMLElement | null>(null)

watch(
  () => call.chatMessages.length,
  async () => {
    await nextTick()
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight })
  },
)

function send(): void {
  if (call.sendChat(text.value)) text.value = ''
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-14 shrink-0 items-center justify-between border-b border-line pr-3 pl-5">
      <h2 class="text-sm font-medium text-ink">聊天</h2>
      <button class="icon-btn size-8" aria-label="关闭面板" @click="call.panel = 'none'">
        <X :size="16" />
      </button>
    </div>
    <div ref="listEl" class="flex-1 space-y-2 overflow-y-auto px-4 py-4">
      <p v-if="!call.chatMessages.length" class="pt-10 text-center text-xs text-ink-3">
        通话建立后即可互发消息
      </p>
      <div
        v-for="m in call.chatMessages"
        :key="m.id"
        class="flex"
        :class="m.from === 'me' ? 'justify-end' : 'justify-start'"
      >
        <p
          class="max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed"
          :class="m.from === 'me' ? 'bg-ink text-white' : 'bg-hover text-ink'"
        >
          {{ m.text }}
        </p>
      </div>
    </div>
    <form class="flex shrink-0 items-center gap-2 border-t border-line p-3" @submit.prevent="send">
      <input
        v-model="text"
        placeholder="发送消息…"
        class="h-9 min-w-0 flex-1 rounded-full bg-hover px-4 text-sm outline-none placeholder:text-ink-3"
      />
      <button
        type="submit"
        :disabled="!text.trim()"
        class="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-all duration-150 hover:bg-accent-strong disabled:opacity-30"
        aria-label="发送"
      >
        <ArrowUp :size="16" />
      </button>
    </form>
  </div>
</template>
