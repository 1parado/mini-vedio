<script setup lang="ts">
import { ref } from 'vue'
import { CircleHelp, Download, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-vue-next'
import { useCall } from '../services/call'
import { exportDiagnostics } from '../services/diagnostics'
import type { NetworkSettings } from '../services/network'

defineProps<{ sidebarHidden?: boolean }>()
const emit = defineEmits<{ 'toggle-sidebar': [] }>()

const call = useCall()
const showSettings = ref(false)
const showHelp = ref(false)
const nameDraft = ref(call.selfName)
const networkDraft = ref<NetworkSettings>({
  stunUrls: [...call.networkSettings.stunUrls],
  turnUrl: call.networkSettings.turnUrl,
  turnUsername: call.networkSettings.turnUsername,
  turnCredential: call.networkSettings.turnCredential,
})
const stunText = ref(networkDraft.value.stunUrls.join('\n'))

function saveName(): void {
  call.setName(nameDraft.value)
}

function saveNetwork(): void {
  call.setNetworkSettings({
    stunUrls: stunText.value.split(/\r?\n/),
    turnUrl: networkDraft.value.turnUrl,
    turnUsername: networkDraft.value.turnUsername,
    turnCredential: networkDraft.value.turnCredential,
  })
}
</script>

<template>
  <header class="relative flex h-[60px] shrink-0 items-center justify-center bg-white px-4">
    <button
      class="icon-btn absolute left-3 size-9"
      :title="sidebarHidden ? '显示边栏' : '隐藏边栏'"
      :aria-label="sidebarHidden ? '显示边栏' : '隐藏边栏'"
      @click="emit('toggle-sidebar')"
    >
      <PanelLeftOpen v-if="sidebarHidden" :size="17" :stroke-width="1.75" />
      <PanelLeftClose v-else :size="17" :stroke-width="1.75" />
    </button>
    <h1 class="text-sm font-medium text-ink">通话</h1>

    <div class="absolute right-3 flex items-center gap-1">
      <button
        class="icon-btn size-8"
        title="设置"
        @click="((showSettings = !showSettings), (showHelp = false))"
      >
        <Settings :size="17" :stroke-width="1.75" />
      </button>
      <button
        class="icon-btn size-8"
        title="帮助"
        @click="((showHelp = !showHelp), (showSettings = false))"
      >
        <CircleHelp :size="17" :stroke-width="1.75" />
      </button>
    </div>

    <Transition name="pop">
      <div
        v-if="showSettings"
        class="absolute right-3 top-[52px] z-40 w-80 rounded-2xl border border-line bg-white p-4 shadow-float"
      >
        <label class="text-xs text-ink-2" for="self-name">设备名称</label>
        <input
          id="self-name"
          v-model="nameDraft"
          class="mt-2 h-9 w-full rounded-lg border border-line px-3 text-sm outline-none transition-colors duration-150 placeholder:text-ink-3 focus:border-ink-3"
          placeholder="本机"
          @change="saveName"
        />
        <p class="mt-2 text-[11px] text-ink-3">对方将在通话中看到此名称</p>
        <label class="mt-4 block text-xs text-ink-2" for="stun-urls">STUN 地址（每行一个）</label>
        <textarea id="stun-urls" v-model="stunText" class="mt-2 h-16 w-full resize-none rounded-lg border border-line px-3 py-2 font-mono text-[11px] outline-none focus:border-ink-3" @change="saveNetwork" />
        <label class="mt-3 block text-xs text-ink-2" for="turn-url">TURN 地址（可选）</label>
        <input id="turn-url" v-model="networkDraft.turnUrl" placeholder="turn:turn.example.com:3478" class="mt-2 h-9 w-full rounded-lg border border-line px-3 font-mono text-[11px] outline-none focus:border-ink-3" @change="saveNetwork" />
        <div class="mt-2 flex gap-2">
          <input v-model="networkDraft.turnUsername" placeholder="TURN 用户名" class="h-9 min-w-0 flex-1 rounded-lg border border-line px-3 text-xs outline-none focus:border-ink-3" @change="saveNetwork" />
          <input v-model="networkDraft.turnCredential" type="password" placeholder="密码" class="h-9 min-w-0 flex-1 rounded-lg border border-line px-3 text-xs outline-none focus:border-ink-3" @change="saveNetwork" />
        </div>
        <p class="mt-2 text-[11px] text-ink-3">网络配置只在下一通话建立时生效。TURN 密码仅保存在当前应用会话，不会写入持久化设置。</p>
      </div>
    </Transition>
    <Transition name="pop">
      <div
        v-if="showHelp"
        class="absolute right-3 top-[52px] z-40 w-64 rounded-2xl border border-line bg-white p-4 shadow-float"
      >
        <p class="text-sm text-ink">mini-vedio 0.1.0</p>
        <p class="mt-1 text-xs leading-relaxed text-ink-3">
          点对点加密通话（WebRTC DTLS-SRTP），通过邀请码与对方直连。
        </p>
        <template v-if="call.selfIPs.length">
          <p class="mt-3 text-xs text-ink-2">本机 IP（局域网）</p>
          <p
            v-for="ip in call.selfIPs"
            :key="ip"
            class="mt-1 font-mono text-xs text-ink"
          >
            {{ ip }}
          </p>
        </template>
        <button class="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-line text-xs text-ink-2 hover:bg-hover" @click="exportDiagnostics">
          <Download :size="14" />导出诊断日志
        </button>
      </div>
    </Transition>
  </header>
</template>

<style scoped>
.pop-enter-active,
.pop-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
