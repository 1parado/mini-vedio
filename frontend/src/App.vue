<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import TopNavigation from './components/TopNavigation.vue'
import JoinRoom from './components/JoinRoom.vue'
import VideoRoom from './components/VideoRoom.vue'
import MobileNav from './components/MobileNav.vue'
import IncomingCall from './components/IncomingCall.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import ContactsPanel from './components/ContactsPanel.vue'
import { useCall } from './services/call'

const call = useCall()
const view = ref<'home' | 'records' | 'contacts'>('home')
const sidebarHidden = ref(localStorage.getItem('mv:sidebar') === '1')
const inCall = computed(() => call.inCall)

function toggleSidebar(): void {
  sidebarHidden.value = !sidebarHidden.value
  localStorage.setItem('mv:sidebar', sidebarHidden.value ? '1' : '0')
}

onMounted(() => {
  void call.initLan()
})
</script>

<template>
  <div class="flex h-full bg-white">
    <Sidebar v-if="!inCall && !sidebarHidden" :active="view" @navigate="view = $event" />
    <div class="flex min-w-0 flex-1 flex-col">
      <TopNavigation v-if="!inCall" :sidebar-hidden="sidebarHidden" @toggle-sidebar="toggleSidebar" />
      <main class="min-h-0 flex-1" :class="inCall ? '' : 'pb-14 md:pb-0'">
        <VideoRoom v-if="inCall" />
        <JoinRoom v-else-if="view === 'home'" />
        <HistoryPanel v-else-if="view === 'records'" />
        <ContactsPanel v-else />
      </main>
    </div>
    <MobileNav v-if="!inCall" v-model:view="view" />
    <IncomingCall />
  </div>
</template>
