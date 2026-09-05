<script setup lang="ts">
import { ref } from 'vue'
import { ArrowRight, Clipboard, Link2, Plus } from 'lucide-vue-next'
import PeerList from './PeerList.vue'
import { useCall } from '../services/call'

const call = useCall()
const code = ref('')
const error = ref('')
const busy = ref(false)

/** 从剪贴板填充邀请码（浏览器端首次点击会请求剪贴板权限） */
async function fillFromClipboard(): Promise<void> {
  const text = await call.pasteFromClipboard()
  if (text) code.value = text
}

async function joinDetected(): Promise<void> {
  code.value = call.detectedInvite
  call.dismissDetected()
  await join()
}

async function join(): Promise<void> {
  if (!code.value.trim() || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await call.joinWithInvite(code.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '邀请码无法解析'
  } finally {
    busy.value = false
  }
}

async function create(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await call.createCall()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '创建通话失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="flex h-full flex-col items-center justify-center px-6 pb-20">
    <h1 class="text-center text-3xl font-semibold tracking-tight text-ink md:text-4xl">
      准备开始通话？
    </h1>
    <p class="mt-3 text-sm text-ink-2">粘贴邀请码加入通话，或创建一通新通话。</p>

    <div
      v-if="call.detectedInvite"
      class="mt-6 flex w-full max-w-xl items-center justify-between rounded-xl bg-hover px-4 py-3"
    >
      <span class="text-xs text-ink-2">剪贴板中发现邀请码</span>
      <div class="flex items-center gap-2">
        <button
          class="h-8 rounded-full border border-line px-3 text-xs text-ink-2 transition-colors duration-150 hover:bg-white"
          @click="call.dismissDetected()"
        >
          忽略
        </button>
        <button
          class="h-8 rounded-full bg-accent px-4 text-xs text-white transition-colors duration-150 hover:bg-accent-strong"
          @click="joinDetected"
        >
          加入
        </button>
      </div>
    </div>

    <form class="mt-10 w-full max-w-xl" @submit.prevent="join">
      <div
        class="flex h-[58px] items-center gap-3 rounded-full border border-line bg-white pr-2 pl-5 shadow-soft transition-colors duration-150 focus-within:border-ink-3"
      >
        <Link2 class="shrink-0 text-ink-3" :size="18" :stroke-width="1.75" />
        <input
          v-model="code"
          placeholder="输入邀请码 / 房间 ID"
          class="h-full min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
        />
        <button
          type="button"
          title="从剪贴板填充"
          aria-label="从剪贴板填充"
          class="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
          @click="fillFromClipboard"
        >
          <Clipboard :size="16" :stroke-width="1.75" />
        </button>
        <button
          type="submit"
          :disabled="!code.trim() || busy"
          class="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-all duration-150 hover:bg-accent-strong active:scale-[0.97] disabled:opacity-30 disabled:hover:bg-accent"
          aria-label="加入通话"
        >
          <ArrowRight :size="18" />
        </button>
      </div>
      <p v-if="error" class="mt-3 text-center text-sm text-danger">{{ error }}</p>
    </form>

    <button
      class="mt-6 inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
      :disabled="busy"
      @click="create"
    >
      <Plus :size="16" :stroke-width="1.75" />
      创建新通话
    </button>

    <PeerList />
    <p v-if="call.notice" class="mt-4 text-xs text-ink-3">{{ call.notice }}</p>
  </section>
</template>
