<script setup lang="ts">
import { History, Phone, Users, Video } from 'lucide-vue-next'

defineProps<{ active: 'home' | 'records' | 'contacts' }>()
const emit = defineEmits<{ navigate: [view: 'home' | 'records' | 'contacts'] }>()

const items = [
  { id: 'home', icon: Phone, label: '新建通话' },
  { id: 'records', icon: History, label: '通话记录' },
  { id: 'contacts', icon: Users, label: '联系人' },
] as const
</script>

<template>
  <aside class="hidden h-full w-16 shrink-0 flex-col items-center border-r border-line bg-white py-4 md:flex">
    <div class="flex size-9 items-center justify-center rounded-xl bg-ink text-white">
      <Video :size="18" :stroke-width="1.75" />
    </div>
    <nav class="mt-6 flex flex-1 flex-col gap-1.5">
      <button
        v-for="it in items"
        :key="it.id"
        :title="it.label"
        :aria-label="it.label"
        class="flex size-10 items-center justify-center rounded-lg transition-colors duration-150"
        :class="active === it.id ? 'bg-hover text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'"
        @click="emit('navigate', it.id)"
      >
        <component :is="it.icon" :size="19" :stroke-width="1.75" />
      </button>
    </nav>
    <div
      class="flex size-8 items-center justify-center rounded-full border border-line bg-hover text-xs text-ink-2"
      title="本机"
    >
      本
    </div>
  </aside>
</template>
