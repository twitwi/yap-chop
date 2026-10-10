import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { parse, stringify } from 'yaml'
import type { Data, Item } from '@/typing'
import { listBoxFiles, resolveFileText, setupYjs } from '@/main-yjs'

export const useLocalStore = defineStore(
  'local',
  () => {
    // like setup() in a component
    const currentList = ref('shop')
    return { currentList }
  },
  {
    persist: { key: 'yap-chop:local' }, // persisted in localStorage
  },
)

// --- YAML-in-a-box backend (replaces `sharing: true` plain-ydoc sync) ---
// Single source: the Y.Text resolved from the full in-box file path
// (e.g. "BOX/@/shop.yaml") through the virtual box filesystem
// (root: node, children id-maps, text nodes with content Y.Text).
// Same store API as before: `main.data.lists[name]` etc.

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function tryParseYaml(raw: string): Data | null {
  if (!raw) return { lists: {} }
  try {
    const parsed = parse(raw) as Data
    if (!parsed || typeof parsed !== 'object' || !parsed.lists) return null
    return parsed
  } catch {
    return null
  }
}

function parseYaml(raw: string): Data {
  return tryParseYaml(raw) ?? { lists: {} }
}

function mergeById(current: Data, incoming: Data, synced: Data): Data {
  const syncedIds = new Set<string>()
  for (const items of Object.values(synced.lists ?? {})) {
    for (const it of items) syncedIds.add(it.id)
  }
  const merged: Data['lists'] = {}
  const allLists = new Set([...Object.keys(current.lists ?? {}), ...Object.keys(incoming.lists ?? {})])
  for (const name of allLists) {
    const curItems = current.lists[name] ?? []
    const incItems = incoming.lists[name] ?? []
    const incById = new Map(incItems.map((it) => [it.id, it]))
    const out: Item[] = incItems.map((it) => ({ ...it }))
    for (const it of curItems) {
      if (!incById.has(it.id) && !syncedIds.has(it.id)) {
        out.push({ ...it })
      }
    }
    merged[name] = out
  }
  return { lists: merged }
}

// Partial write: common prefix/suffix, replace only the changed middle range.
function applyTextDelta(ytext: Y.Text, oldStr: string, newStr: string) {
  if (oldStr === newStr) return
  let prefix = 0
  const maxPrefix = Math.min(oldStr.length, newStr.length)
  while (prefix < maxPrefix && oldStr[prefix] === newStr[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(oldStr.length - prefix, newStr.length - prefix)
  while (suffix < maxSuffix && oldStr[oldStr.length - 1 - suffix] === newStr[newStr.length - 1 - suffix]) {
    suffix++
  }
  const delCount = oldStr.length - prefix - suffix
  const insert = newStr.slice(prefix, newStr.length - suffix)
  if (delCount > 0) ytext.delete(prefix, delCount)
  if (insert.length > 0) ytext.insert(prefix, insert)
}

let boxSingleton: {
  ydoc: Y.Doc
  boxPath: string
  provider: WebsocketProvider | null
  whenReady: Promise<void>
} | null = null
function getBox() {
  if (!boxSingleton) {
    const { ydoc, boxPath, provider, whenReady } = setupYjs()
    boxSingleton = { ydoc, boxPath, provider, whenReady }
  }
  return boxSingleton
}

const SEED: Data = { lists: { shop: [] } }

export const useMainStore = defineStore('main', () => {
  // like setup() in a component
  const { ydoc, boxPath, provider, whenReady } = getBox()
  const data = ref<Data>({ lists: {} })
  // websocket connection state, for UI + console diagnostics
  const wsStatus = ref('connecting')
  const wsSynced = ref(false)
  // box inspection: which file is active, which files the box holds,
  // and the file's raw YAML text as stored in Yjs
  const activeFile = ref(boxPath)
  const boxFiles = ref<string[]>([])
  const rawYaml = ref('')
  let syncedYaml = ''
  let synced: Data = { lists: {} }
  let applyingRemote = false
  // Nothing is resolved or written before providers sync. Local edits
  // meanwhile only flag dirty and flush after ready.
  let ready = false
  let dirty = false
  let bound: Y.Text | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function refreshBoxMeta() {
    boxFiles.value = listBoxFiles(ydoc, boxPath)
    rawYaml.value = bound ? bound.toString() : ''
  }

  function onText() {
    if (!bound) return
    const raw = bound.toString()
    if (raw === syncedYaml) return
    applyingRemote = true
    try {
      const incoming = tryParseYaml(raw)
      if (incoming === null) {
        syncedYaml = raw // adopt as delta base, never wipe the model
        refreshBoxMeta()
        return
      }
      data.value = mergeById(data.value, incoming, synced)
      syncedYaml = raw
      synced = clone(data.value)
      refreshBoxMeta()
    } finally {
      applyingRemote = false
    }
  }

  function bind(t: Y.Text | null | undefined) {
    if ((t ?? null) === bound) return
    if (bound) bound.unobserve(onText)
    bound = t ?? null
    if (bound) bound.observe(onText)
    refreshBoxMeta()
  }

  // Resolve the file's live Y.Text through the box filesystem, retrying
  // until it appears (it arrives via IndexedDB/websocket sync, or is
  // created in the ready flush below). Re-resolve every time: the entry
  // may be (re)created remotely.
  function tryResolve() {
    if (bound) return
    const t = resolveFileText(ydoc, boxPath, false)
    if (t) {
      bind(t)
      onText()
    } else if (!ready) {
      retryTimer = setTimeout(tryResolve, 300)
    }
  }
  tryResolve()

  // Publish inside one transaction, always against the live entry (create
  // the file node itself here — only ever called when ready).
  function publish(yaml: string) {
    ydoc.transact(() => {
      let t = resolveFileText(ydoc, boxPath, false)
      if (!t) {
        t = resolveFileText(ydoc, boxPath, true)
        if (!t) return
      }
      bind(t)
      applyTextDelta(t, t.toString(), yaml)
      syncedYaml = yaml
      synced = clone(parseYaml(yaml))
      refreshBoxMeta()
    })
  }

  // Local (pinia -> Yjs): partial delta write of the single YAML file.
  let scheduled = false
  watch(
    data,
    (v) => {
      dirty = true
      if (!ready || applyingRemote) return
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        const yaml = stringify(v)
        if (yaml === syncedYaml) return
        publish(yaml)
      })
    },
    { deep: true },
  )

  // Flush once providers sync: adopt loaded content (or create + seed a
  // fresh file), then publish pre-ready edits on top.
  whenReady.then(() => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    applyingRemote = true
    try {
      let t = resolveFileText(ydoc, boxPath, false)
      if (!t) {
        t = resolveFileText(ydoc, boxPath, true)
        bind(t)
        const yaml = stringify(dirty ? data.value : SEED)
        if (t) publish(yaml)
        if (!dirty) data.value = parseYaml(yaml)
      } else {
        bind(t)
        const cur = t.toString()
        if (cur.length === 0) {
          const yaml = stringify(dirty ? data.value : SEED)
          publish(yaml)
          if (!dirty) data.value = parseYaml(yaml)
        } else {
          const incoming = tryParseYaml(cur)
          if (incoming !== null) {
            data.value = mergeById(data.value, incoming, synced)
            syncedYaml = cur
            synced = clone(data.value)
            const yaml = stringify(data.value)
            if (yaml !== cur) publish(yaml) // push pre-ready local additions
          } else {
            syncedYaml = cur
          }
        }
      }
      refreshBoxMeta()
    } finally {
      applyingRemote = false
      ready = true
    }
  })

  if (provider) {
    provider.on('status', (e: { status: string }) => {
      wsStatus.value = e.status
      console.log('[yjs] websocket status:', e.status)
    })
    provider.on('sync', (synced_: boolean) => {
      wsSynced.value = synced_
      console.log('[yjs] websocket synced:', synced_)
    })
  } else {
    wsStatus.value = 'disabled'
  }

  return { data, wsStatus, wsSynced, activeFile, boxFiles, rawYaml }
})
