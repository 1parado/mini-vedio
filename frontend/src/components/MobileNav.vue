<script setup lang="ts">
import { History, Phone, Users } from 'lucide-vue-next'

const view = defineModel<'home' | 'records' | 'contacts'>('view', { default: 'home' })

const items = [
  { id: 'home', icon: Phone, label: '新建通话' },
  { id: 'records', icon: History, label: '通话记录' },
  { id: 'contacts', icon: Users, label: '联系人' },
] as const
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-30 flex h-14 items-center justify-around border-t border-line bg-white md:hidden"
  >
    <button
      v-for="it in items"
      :key="it.id"
      :aria-label="it.label"
      :title="it.label"
      class="flex size-10 items-center justify-center rounded-lg transition-colors duration-150"
      :class="view === it.id ? 'bg-hover text-ink' : 'text-ink-2'"
      @click="view = it.id"
    >
      <component :is="it.icon" :size="20" :stroke-width="1.75" />
    </button>
  </nav>
</template>
