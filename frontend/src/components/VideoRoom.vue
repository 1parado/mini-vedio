<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import qrcode from 'qrcode-generator'
import { Check, Copy, Maximize2, PictureInPicture2, QrCode } from 'lucide-vue-next'
import VideoTile from './VideoTile.vue'
import CallControls from './CallControls.vue'
import ConnectionStatus from './ConnectionStatus.vue'
import ParticipantPanel from './ParticipantPanel.vue'
import ChatPanel from './ChatPanel.vue'
import { useCall } from '../services/call'

const call = useCall()

// 布局：false = 远端大画面 + 本地右下角小窗；true = 互换
const swapped = ref(false)
const largeStream = computed(() => (swapped.value ? call.localStream : call.remoteStream))
const largeLabel = computed(() => (swapped.value ? call.selfName : call.peerName))
const pipStream = computed(() => (swapped.value ? call.remoteStream : call.localStream))
const pipLabel = computed(() => (swapped.value ? call.peerName : call.selfName))

const stageEl = ref<HTMLElement | null>(null)
function toggleStageFullscreen(): void {
  const el = stageEl.value
  if (!el) return
  if (document.fullscreenElement) {
    void document.exitFullscreen()
  } else {
    void el.requestFullscreen()
  }
}

// 右侧面板可拖拽调宽（280–560px，双击手柄复位，宽度记忆）
const PANEL_MIN = 280
const PANEL_MAX = 560
const panelWidth = ref(Number(localStorage.getItem('mv:panelW')) || 320)
const panelStyle = computed(() => ({
  width: Math.min(panelWidth.value, window.innerWidth - 48) + 'px',
}))
function startResize(e: MouseEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startW = panelWidth.value
  const onMove = (ev: MouseEvent): void => {
    panelWidth.value = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + (startX - ev.clientX)))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    localStorage.setItem('mv:panelW', String(panelWidth.value))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
function resetPanelWidth(): void {
  panelWidth.value = 320
  localStorage.setItem('mv:panelW', '320')
}

// 等待交换邀请码的阶段：发起方在 idle 时展示邀请码，加入方在回传回复码前一直展示
const waiting = computed(
  () => (call.phase === 'idle' && !!call.inviteCode) || !!call.replyCode,
)

// 等待时点"放大自己"会自动收起邀请码浮层；顶部小按钮可召回
const panelMinimized = ref(false)
watch(waiting, (w) => {
  if (w) panelMinimized.value = false
})
function toggleSwap(): void {
  swapped.value = !swapped.value
  if (waiting.value) panelMinimized.value = swapped.value
}

/** 邀请码二维码（手机扫码免传码）；超出容量或生成失败时返回空串隐藏 */
function qrSvg(code: string): string {
  try {
    const qr = qrcode(0, 'L')
    qr.addData(code)
    qr.make()
    return qr.createDataURL(3, 2)
  } catch {
    return ''
  }
}
const inviteQr = computed(() => (call.inviteCode ? qrSvg(call.inviteCode) : ''))

const copied = ref<'invite' | 'reply' | null>(null)
async function copy(text: string, which: 'invite' | 'reply'): Promise<void> {
  await navigator.clipboard.writeText(text)
  copied.value = which
  window.setTimeout(() => (copied.value = null), 1500)
}

const answer = ref('')
const answerError = ref('')
async function submitAnswer(): Promise<void> {
  answerError.value = ''
  try {
    await call.acceptReplyCode(answer.value)
    answer.value = ''
  } catch (e) {
    answerError.value = e instanceof Error ? e.message : '回复码无法解析'
  }
}
</script>

<template>
  <section class="relative h-full overflow-hidden bg-[#0f0f0f]">
    <!-- 大画面（默认远端，可切换为本地；等待时被邀请浮层覆盖，可最小化） -->
    <div
      v-if="!waiting || panelMinimized"
      ref="stageEl"
      class="absolute inset-0 flex items-center justify-center p-3 md:p-6"
    >
      <div class="h-full w-full overflow-hidden rounded-2xl bg-[#161616]">
        <VideoTile
          :stream="largeStream"
          :mirror="swapped"
          :video-off="swapped && !call.camOn"
          :label="largeLabel"
          @dblclick="toggleStageFullscreen"
        />
      </div>
    </div>

    <!-- 等待交换邀请码 -->
    <div v-else class="absolute inset-0 flex items-center justify-center p-4">
      <div class="w-full max-w-md rounded-2xl bg-white p-5 shadow-float">
        <template v-if="call.inviteCode">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-medium text-ink">① 把邀请码发给对方</h2>
            <button
              class="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-ink-2 transition-colors duration-150 hover:bg-hover"
              @click="copy(call.inviteCode, 'invite')"
            >
              <Check v-if="copied === 'invite'" :size="13" class="text-ok" />
              <Copy v-else :size="13" />
              {{ copied === 'invite' ? '已复制' : '复制' }}
            </button>
          </div>
          <p class="mt-1 text-xs text-ink-3">手机在场时可扫下方二维码，免去传码。</p>
          <img
            v-if="inviteQr"
            :src="inviteQr"
            alt="邀请码二维码"
            class="mx-auto mt-3 w-full max-w-[280px] rounded-xl border border-line bg-white p-2"
          />
          <details class="mt-2">
            <summary class="cursor-pointer select-none px-1 text-xs text-ink-3">
              查看原始文本
            </summary>
            <textarea
              readonly
              :value="call.inviteCode"
              class="mt-2 h-20 w-full resize-none rounded-xl border border-line bg-[#fafafa] p-3 font-mono text-[11px] leading-relaxed text-ink-2 outline-none"
            />
          </details>
          <div class="mt-4">
            <p class="text-xs font-medium text-ink">② 粘贴对方的回复码</p>
            <div class="mt-2 flex gap-2">
              <input
                v-model="answer"
                placeholder="MV1-…"
                class="h-10 min-w-0 flex-1 rounded-xl border border-line px-3 text-sm outline-none transition-colors duration-150 placeholder:text-ink-3 focus:border-ink-3"
                @keydown.enter.prevent="submitAnswer"
              />
              <button
                class="h-10 shrink-0 rounded-xl bg-accent px-4 text-sm text-white transition-colors duration-150 hover:bg-accent-strong disabled:opacity-30"
                :disabled="!answer.trim()"
                @click="submitAnswer"
              >
                连接
              </button>
            </div>
            <p v-if="answerError" class="mt-2 text-xs text-danger">{{ answerError }}</p>
          </div>
        </template>

        <template v-else>
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-medium text-ink">② 把回复码发回给对方</h2>
            <button
              class="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-ink-2 transition-colors duration-150 hover:bg-hover"
              @click="copy(call.replyCode, 'reply')"
            >
              <Check v-if="copied === 'reply'" :size="13" class="text-ok" />
              <Copy v-else :size="13" />
              {{ copied === 'reply' ? '已复制' : '复制' }}
            </button>
          </div>
          <p class="mt-1 text-xs text-ink-3">对方粘贴此码后，通话将自动建立。</p>
          <details class="mt-2">
            <summary class="cursor-pointer select-none px-1 text-xs text-ink-3">
              查看原始文本
            </summary>
            <textarea
              readonly
              :value="call.replyCode"
              class="mt-2 h-24 w-full resize-none rounded-xl border border-line bg-[#fafafa] p-3 font-mono text-[11px] leading-relaxed text-ink-2 outline-none"
            />
          </details>
        </template>
      </div>
    </div>

    <!-- 等待面板最小化后的召回按钮 -->
    <button
      v-if="waiting && panelMinimized"
      class="absolute left-1/2 top-16 z-20 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full bg-white/95 px-4 text-xs text-ink shadow-float transition-transform duration-150 hover:scale-[1.03]"
      @click="panelMinimized = false"
    >
      <QrCode :size="14" />
      邀请码面板
    </button>

    <!-- 本地/远端小窗（悬停出现布局切换按钮） -->
    <div
      v-if="call.localStream || call.remoteStream"
      class="group absolute bottom-24 right-4 z-10 aspect-video w-36 overflow-hidden rounded-xl border border-white/10 shadow-float md:bottom-28 md:right-6 md:w-56"
    >
      <VideoTile
        :stream="pipStream"
        :muted="!swapped"
        :mirror="!swapped"
        :video-off="!swapped && !call.camOn"
        :label="pipLabel"
      />
      <button
        v-if="call.localStream"
        :title="swapped ? '切回小窗' : '本地画面放大'"
        class="absolute right-1.5 top-1.5 z-10 flex size-7 items-center justify-center rounded-lg bg-black/50 text-white/90 opacity-0 transition-all duration-150 hover:bg-black/70 group-hover:opacity-100"
        @click="toggleSwap"
      >
        <PictureInPicture2 v-if="swapped" :size="14" />
        <Maximize2 v-else :size="14" />
      </button>
    </div>

    <ConnectionStatus class="absolute top-4 left-1/2 z-10 -translate-x-1/2" />
    <div class="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 md:bottom-6">
      <CallControls />
    </div>

    <!-- 右侧面板（左缘可拖拽调宽） -->
    <Transition name="panel">
      <aside
        v-if="call.panel !== 'none'"
        class="absolute right-0 top-0 z-20 flex h-full flex-col border-l border-line bg-white"
        :style="panelStyle"
      >
        <div
          class="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors duration-150 hover:bg-accent/40"
          title="拖拽调整宽度，双击复位"
          @mousedown="startResize"
          @dblclick="resetPanelWidth"
        />
        <ParticipantPanel v-if="call.panel === 'participants'" />
        <ChatPanel v-else />
      </aside>
    </Transition>
  </section>
</template>

<style scoped>
.panel-enter-active,
.panel-leave-active {
  transition: transform 0.2s ease;
}
.panel-enter-from,
.panel-leave-to {
  transform: translateX(100%);
}
</style>
