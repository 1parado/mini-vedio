<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Pencil, Phone, Plus, Trash2, X } from 'lucide-vue-next'
import type { Contact } from '../types'
import { listContacts, removeContact, saveContact } from '../services/contacts'
import { useCall } from '../services/call'

const call = useCall()
const contacts = ref<Contact[]>([])
const editing = ref<Contact | null>(null)
const name = ref('')
const ip = ref('')
const error = ref('')

function refresh(): void {
  contacts.value = listContacts()
}

function openNew(): void {
  editing.value = null
  name.value = ''
  ip.value = ''
  error.value = ''
}

function edit(contact: Contact): void {
  editing.value = contact
  name.value = contact.name
  ip.value = contact.ip ?? ''
  error.value = ''
}

function save(): void {
  if (!name.value.trim()) {
    error.value = '请输入联系人名称'
    return
  }
  saveContact({ id: editing.value?.id, name: name.value, ip: ip.value })
  refresh()
  openNew()
}

function remove(id: string): void {
  removeContact(id)
  refresh()
}

async function connect(contact: Contact): Promise<void> {
  if (!contact.ip) return
  try {
    await call.connectIP(contact.ip)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '连接失败'
  }
}

onMounted(() => {
  refresh()
  openNew()
})
</script>

<template>
  <section class="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-8">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-lg font-semibold text-ink">联系人</h1>
        <p class="mt-1 text-xs text-ink-3">保存名称和局域网 IP，方便下次直连</p>
      </div>
      <button class="icon-btn size-9" title="新增联系人" aria-label="新增联系人" @click="openNew">
        <Plus :size="17" />
      </button>
    </div>
    <form class="mt-5 rounded-xl border border-line p-4" @submit.prevent="save">
      <div class="flex gap-2">
        <input v-model="name" required placeholder="联系人名称" class="h-9 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm outline-none focus:border-ink-3" />
        <input v-model="ip" placeholder="局域网 IPv4（可选）" class="h-9 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm outline-none focus:border-ink-3" />
      </div>
      <p v-if="error" class="mt-2 text-xs text-danger">{{ error }}</p>
      <div class="mt-3 flex justify-end gap-2">
        <button v-if="editing" type="button" class="icon-btn size-8" title="取消编辑" aria-label="取消编辑" @click="openNew"><X :size="15" /></button>
        <button type="submit" class="h-8 rounded-lg bg-ink px-3 text-xs text-white">{{ editing ? '保存修改' : '保存联系人' }}</button>
      </div>
    </form>
    <ul v-if="contacts.length" class="mt-5 divide-y divide-line overflow-y-auto rounded-xl border border-line">
      <li v-for="contact in contacts" :key="contact.id" class="flex items-center gap-3 px-4 py-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-hover text-sm text-ink-2">{{ contact.name.charAt(0) }}</span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-ink">{{ contact.name }}</p>
          <p class="truncate text-xs text-ink-3">{{ contact.ip || '未设置 IP' }}</p>
        </div>
        <button v-if="contact.ip" class="icon-btn size-8" title="通过 IP 直连" aria-label="通过 IP 直连" @click="connect(contact)"><Phone :size="15" /></button>
        <button class="icon-btn size-8" title="编辑联系人" aria-label="编辑联系人" @click="edit(contact)"><Pencil :size="15" /></button>
        <button class="icon-btn size-8 text-danger" title="删除联系人" aria-label="删除联系人" @click="remove(contact.id)"><Trash2 :size="15" /></button>
      </li>
    </ul>
    <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p class="text-sm text-ink-2">还没有联系人</p>
      <p class="text-xs text-ink-3">添加名称和 IP 后即可从这里发起局域网直连</p>
    </div>
  </section>
</template>
