<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'

const props = defineProps<{
  stream: MediaStream | null
  muted?: boolean
  mirror?: boolean
  label?: string
  /** 摄像头被用户关闭时为 true：显示占位头像而不是被禁用轨道的黑帧 */
  videoOff?: boolean
}>()

const videoEl = ref<HTMLVideoElement | null>(null)
watchEffect(() => {
  const el = videoEl.value
  if (!el) return
  el.srcObject = props.stream
  if (props.stream) el.play().catch(() => {})
})

const hasVideo = computed(
  () => !!props.stream && props.stream.getVideoTracks().length > 0 && !props.videoOff,
)
const initial = computed(() => (props.label ? props.label.charAt(0) : '对'))
</script>

<template>
  <div class="relative h-full w-full overflow-hidden bg-[#161616]">
    <video
      v-show="hasVideo"
      ref="videoEl"
      autoplay
      playsinline
      :muted="muted"
      class="h-full w-full object-cover"
      :class="mirror ? '-scale-x-100' : ''"
    />
    <div v-if="!hasVideo" class="flex h-full w-full flex-col items-center justify-center gap-3">
      <div class="flex size-14 items-center justify-center rounded-full bg-white/10 text-lg text-white/80">
        {{ initial }}
      </div>
      <span v-if="label" class="text-xs text-white/50">{{ label }}</span>
    </div>
    <div
      v-if="label && hasVideo"
      class="absolute bottom-2 left-2 rounded-md bg-black/45 px-2 py-0.5 text-[11px] text-white/90"
    >
      {{ label }}
    </div>
  </div>
</template>
