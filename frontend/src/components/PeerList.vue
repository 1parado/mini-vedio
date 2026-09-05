<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Phone, UserPlus } from 'lucide-vue-next'
import { useCall } from '../services/call'
import { listContacts, saveContact } from '../services/contacts'

const call = useCall()
const showHint = ref(false)
const ipInput = ref('')
const ipError = ref('')
const savedPeerIds = ref(new Set<string>())

onMounted(() => {
  window.setTimeout(() => (showHint.value = true), 15000)
  savedPeerIds.value = new Set(listContacts().filter((contact) => contact.peerId).map((contact) => contact.peerId!))
})

function savePeer(name: string, peerId: string): void {
  saveContact({ name, peerId })
  savedPeerIds.value = new Set([...savedPeerIds.value, peerId])
}

async function connectIP(): Promise<void> {
  const ip = ipInput.value.trim()
  if (!ip) return
  ipError.value = ''
  try {
    await call.connectIP(ip)
    ipInput.value = ''
  } catch (e) {
    ipError.value = e instanceof Error ? e.message : '连接失败'
  }
}
</script>

<template>
  <section v-if="call.lanReady" class="mt-14 w-full max-w-xl">
    <h2 class="mb-2 px-3 text-xs font-medium text-ink-3">附近的设备</h2>
    <ul v-if="call.lanPeers.length" class="flex flex-col gap-0.5">
      <li v-for="p in call.lanPeers" :key="p.id">
        <button
          class="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors duration-150 hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent"
          :disabled="p.state === 'busy'"
          @click="call.startLanCall(p)"
        >
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-white text-xs text-ink-2"
          >
            {{ p.name.charAt(0) }}
          </span>
          <span class="min-w-0 flex-1 truncate text-sm text-ink">{{ p.name }}</span>
          <span v-if="p.state === 'busy'" class="text-xs text-ink-3">通话中</span>
          <button
            v-if="!savedPeerIds.has(p.id)"
            class="icon-btn size-8 shrink-0"
            title="保存联系人"
            aria-label="保存联系人"
            @click.stop="savePeer(p.name, p.id)"
          >
            <UserPlus :size="15" :stroke-width="1.75" />
          </button>
          <Phone v-else :size="15" :stroke-width="1.75" class="shrink-0 text-ink-3" />
        </button>
      </li>
    </ul>
    <p v-else class="px-3 text-xs text-ink-3">
      {{ showHint ? '暂未发现设备' : '正在搜索同一局域网内的设备…' }}
    </p>

    <div
      v-if="showHint && !call.lanPeers.length"
      class="mt-3 rounded-xl bg-hover px-4 py-3 text-xs leading-relaxed text-ink-2"
    >
      <p>找不到设备？依次检查：</p>
      <p class="mt-1">① 两台电脑都要在 Windows 防火墙放行 mini-vedio（专用 + 公用网络）</p>
      <p>② 路由器可能开启了 AP 隔离，可改用「创建新通话」的邀请码</p>
      <p>③ 或在下方输入对方 IP 直连（对方可在 设置 → 帮助 中查看 IP）</p>
    </div>

    <form
      v-if="call.lanReady"
      class="mt-2 flex items-center gap-2 px-1"
      @submit.prevent="connectIP"
    >
      <input
        v-model="ipInput"
        placeholder="通过 IP 直连，例如 192.168.1.23"
        class="h-9 min-w-0 flex-1 rounded-full bg-hover px-4 text-xs outline-none placeholder:text-ink-3"
      />
      <button
        type="submit"
        :disabled="!ipInput.trim()"
        class="h-9 shrink-0 rounded-full border border-line px-4 text-xs text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-40"
      >
        连接
      </button>
    </form>
    <p v-if="ipError" class="mt-1 px-3 text-xs text-danger">{{ ipError }}</p>
  </section>
</template>
