<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Phone, UserPlus } from 'lucide-vue-next'
import { useCall } from '../services/call'
import { listContacts, saveContact } from '../services/contacts'

const call = useCall()
const savedPeerIds = ref(new Set<string>())

onMounted(() => {
  savedPeerIds.value = new Set(
    listContacts()
      .filter((contact) => contact.peerId)
      .map((contact) => contact.peerId!),
  )
})

function savePeer(name: string, peerId: string): void {
  saveContact({ name, peerId })
  savedPeerIds.value = new Set([...savedPeerIds.value, peerId])
}
</script>

<template>
  <!-- 仅在确实发现设备时渲染，首页保持极简 -->
  <section v-if="call.lanReady && call.lanPeers.length" class="mt-14 w-full max-w-xl">
    <h2 class="mb-2 px-3 text-xs font-medium text-ink-3">附近的设备</h2>
    <ul class="flex flex-col gap-0.5">
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
  </section>
</template>
