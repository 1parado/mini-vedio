import type { Contact } from '../types'

const STORAGE_KEY = 'mv:contacts'

function read(): Contact[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as Contact[]) : []
  } catch {
    return []
  }
}

function write(contacts: Contact[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts))
  } catch {
    // 本地存储不可用时不影响即时呼叫。
  }
}

export function listContacts(): Contact[] {
  return read().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function saveContact(input: { id?: string; name: string; ip?: string; peerId?: string }): Contact {
  const now = new Date().toISOString()
  const contacts = read()
  const existing = input.id ? contacts.find((contact) => contact.id === input.id) : undefined
  const contact: Contact = {
    id: existing?.id ?? crypto.randomUUID(),
    name: input.name.trim(),
    ip: input.ip?.trim() || undefined,
    peerId: input.peerId?.trim() || undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  write([contact, ...contacts.filter((item) => item.id !== contact.id)])
  return contact
}

export function removeContact(id: string): void {
  write(read().filter((contact) => contact.id !== id))
}

export function contactName(peerId: string, fallback: string): string {
  return read().find((contact) => contact.peerId === peerId)?.name ?? fallback
}
