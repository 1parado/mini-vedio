<script setup lang="ts">
import { ref } from 'vue'
import {
  Ellipsis,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Users,
  Video,
  VideoOff,
} from 'lucide-vue-next'
import { useCall } from '../services/call'

const call = useCall()
const showMore = ref(false)
</script>

<template>
  <div class="relative">
    <Transition name="pop">
      <div
        v-if="showMore"
        class="absolute bottom-[62px] left-1/2 w-40 -translate-x-1/2 rounded-xl border border-line bg-white p-1.5 shadow-float"
      >
        <button
          class="menu-item"
          @click="((call.panel = 'participants'), (showMore = false))"
        >
          <Users :size="16" :stroke-width="1.75" />参与者
        </button>
        <button class="menu-item" @click="((call.panel = 'chat'), (showMore = false))">
          <MessageSquare :size="16" :stroke-width="1.75" />聊天
        </button>
      </div>
    </Transition>

    <div class="flex items-center gap-1 rounded-full border border-line bg-white p-1.5 shadow-float">
      <button
        :title="call.micOn ? '关闭麦克风' : '开启麦克风'"
        class="dock-btn"
        :class="{ 'dock-btn-off': !call.micOn }"
        @click="call.toggleMic()"
      >
        <Mic v-if="call.micOn" :size="18" :stroke-width="1.75" />
        <MicOff v-else :size="18" :stroke-width="1.75" />
      </button>
      <button
        :title="call.camOn ? '关闭摄像头' : '开启摄像头'"
        class="dock-btn"
        :class="{ 'dock-btn-off': !call.camOn }"
        @click="call.toggleCam()"
      >
        <Video v-if="call.camOn" :size="18" :stroke-width="1.75" />
        <VideoOff v-else :size="18" :stroke-width="1.75" />
      </button>
      <button
        title="屏幕共享"
        class="dock-btn"
        :class="{ 'is-accent': call.sharing }"
        @click="call.toggleShare()"
      >
        <MonitorUp :size="18" :stroke-width="1.75" />
      </button>
      <button title="更多" class="dock-btn" @click="showMore = !showMore">
        <Ellipsis :size="18" :stroke-width="1.75" />
      </button>
      <span class="mx-1 h-6 w-px bg-line"></span>
      <button
        title="挂断"
        class="flex size-11 items-center justify-center rounded-full bg-danger text-white transition-all duration-150 hover:bg-red-700 active:scale-[0.96]"
        @click="call.hangup()"
      >
        <PhoneOff :size="18" :stroke-width="1.75" />
      </button>
    </div>
  </div>
</template>

<style scoped>
@reference "../style.css";

.dock-btn {
  @apply flex size-11 items-center justify-center rounded-full text-ink transition-colors duration-150 hover:bg-hover active:bg-line;
}
.dock-btn-off {
  @apply bg-hover text-ink-2;
}
.dock-btn.is-accent {
  @apply bg-accent/10 text-accent;
}
.pop-enter-active,
.pop-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translate(-50%, 4px);
}
</style>
