import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { parse, stringify } from 'yaml'
import type { Data, Item, State } from '@/typing'
import { StateSpec } from '@/typing'
import { deepEqual, normalizeLists } from '@/repair'
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

// Publish iff the model holds something the last-synced state doesn't.
// Text-only differences (repair echoes, remote adoptions, no-op
// reassignments) never publish — even though the text differs, the model
// carries nothing new. Pure: unit-tested in __tests__/repair.spec.ts.
export function modelNeedsPublish(next: Data, syncedYamlText: string, syncedModel: Data): boolean {
  if (deepEqual(next, syncedModel)) return false
  return stringify(next) !== syncedYamlText
}

// Specs for constrained item fields. Free-text fields (description) have no
// entry: nothing valid to check them against. Adding a future constrained
// field is one entry here.
const ITEM_SPECS = { state: StateSpec }

// Inverse ops for the local undo stack. `list` pins the origin list so undo
// applies correctly even after the user switched lists.
export type Inverse =
  | { op: 'setState'; list: string; id: string; prev: State }
  | { op: 'setDescription'; list: string; id: string; prev: string }
  | { op: 'add'; list: string; id: string }
  | { op: 'remove'; list: string; item: Item; index: number }
  | { op: 'addList'; name: string }

const MAX_HISTORY = 50

// Pure undo helpers (unit-tested in __tests__/undo.spec.ts). The store's
// record()/undo() below are thin wrappers binding these to its data/history.
export function pushHistory(history: Inverse[], inv: Inverse, cap = MAX_HISTORY): void {
  history.push(inv)
  if (history.length > cap) history.shift()
}

export function applyInverse(data: Data, inv: Inverse): void {
  if (inv.op === 'addList') {
    const l = data.lists[inv.name]
    if (l && l.length === 0) delete data.lists[inv.name]
    return
  }
  const items = data.lists[inv.list]
  switch (inv.op) {
    case 'setState': {
      const it = items?.find((i) => i.id === inv.id)
      if (it) it.state = inv.prev
      break
    }
    case 'setDescription': {
      const it = items?.find((i) => i.id === inv.id)
      if (it) it.description = inv.prev
      break
    }
    case 'add': {
      const l = data.lists[inv.list]
      if (l) {
        const ix = l.findIndex((i) => i.id === inv.id)
        if (ix >= 0) l.splice(ix, 1)
      }
      break
    }
    case 'remove': {
      const l = data.lists[inv.list] ?? (data.lists[inv.list] = [])
      l.splice(Math.min(inv.index, l.length), 0, { ...inv.item })
      break
    }
  }
}

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
      normalizeLists(data.value.lists, ITEM_SPECS)
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
  // Publish condition: the model must differ from the last-synced model.
  // Text-only differences (repair echoes, remote adoptions, no-op
  // reassignments) never write — the async watcher runs after onText already
  // reset applyingRemote, so the flag alone cannot suppress them.
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
        if (!modelNeedsPublish(v, syncedYaml, synced)) return
        publish(stringify(v))
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
            normalizeLists(incoming.lists, ITEM_SPECS)
            data.value = mergeById(data.value, incoming, synced)
            normalizeLists(data.value.lists, ITEM_SPECS)
            syncedYaml = cur
            synced = clone(data.value)
            // Push pre-ready local additions only: if the merged model is
            // fully represented by the incoming text, any text difference is
            // just repair echo, which must not be written back.
            if (modelNeedsPublish(data.value, cur, incoming)) {
              const yaml = stringify(data.value)
              if (yaml !== cur) publish(yaml)
            }
          } else if (dirty) {
            // Unparseable bytes, but we hold parsed-valid local content: ours
            // is the only known-good model, publish it.
            publish(stringify(data.value))
          } else {
            // Unparseable bytes, nothing local to save: adopt as delta base
            // and wait — never overwrite others' in-flight content.
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

  // --- Local per-tap undo (in-memory, local edits only, no toasts) ---
  // History of inverse ops, recorded by the UI before each local mutation
  // (see Inverse below). Remote changes never push. Undo applies the
  // inverse as a normal local edit (flows through watcher -> publish).
  // addList undo drops the list only if still empty, so it can never wipe
  // items a peer added meanwhile.
  const history: Inverse[] = []
  const undoCount = ref(0)
  const canUndo = computed(() => undoCount.value > 0)
  function record(inv: Inverse) {
    pushHistory(history, inv)
    undoCount.value = history.length
  }
  function undo() {
    const inv = history.pop()
    undoCount.value = history.length
    if (!inv) return
    applyInverse(data.value, inv)
  }

  return { data, wsStatus, wsSynced, activeFile, boxFiles, rawYaml, record, undo, undoCount, canUndo }
})
