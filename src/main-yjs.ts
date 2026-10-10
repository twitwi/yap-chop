import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import { getYText } from '@/vendor/yjs-datatools/ybox'
import { ROOT_ID } from '@/vendor/yjs-datatools/ybox'

export const SEP = '::'
export const EG_CONFIG = `todo.com${SEP}doc${SEP}token${SEP}BOX/@/shop.yaml`

export const APP_LOCAL_STORAGE_KEY = 'yap-chop:server'

// Box layout (same semantics as yjs-datatools ybox.ts, vendored under
// src/vendor): the 4th config element is a full in-box file path, e.g.
// "BOX/@/shop.yaml". "@" opens the box — BOX is a Y.Map under the doc root
// holding a virtual filesystem (root: node, children id-maps, text nodes
// with a content Y.Text) — and "shop.yaml" is resolved inside it.
// Only the exact "/@/" segment is reserved.
export const DEFAULT_BOX_PATH = `BOX/@/shop.yaml`

// Resolve the file's live Y.Text doc. Never creates unless asked — callers
// must only pass create=true after providers sync, or concurrent creations
// orphan each other (distinct node ids, children-key LWW).
export function resolveFileText(ydoc: Y.Doc, fullPath: string, create = false): Y.Text | undefined {
  return getYText(ydoc, fullPath, create) ?? undefined
}

// List file paths (e.g. "shop.yaml", "lists/old.yaml") held by the box of
// the given full in-box path, by walking the virtual filesystem.
export function listBoxFiles(ydoc: Y.Doc, fullPath: string): string[] {
  const steps = fullPath.split('/').filter(Boolean)
  let p: Y.Map<unknown> = ydoc.getMap()
  for (const k of steps) {
    if (k === '@') break
    const next = p.get(k)
    if (!(next instanceof Y.Map)) return []
    p = next as Y.Map<unknown>
  }
  const box = p
  const root = box.get(ROOT_ID)
  if (!(root instanceof Y.Map)) return []
  const out: string[] = []
  const walk = (node: Y.Map<unknown>, prefix: string) => {
    const type = node.get('type')
    const children = node.get('children')
    if (type !== 'directory' || !(children instanceof Y.Map)) return
    for (const [name, id] of children as Y.Map<string>) {
      const sub = box.get(id)
      if (!(sub instanceof Y.Map)) continue
      const subMap = sub as Y.Map<unknown>
      if (subMap.get('type') === 'text') {
        out.push(prefix + name)
      } else {
        walk(subMap, `${prefix}${name}/`)
      }
    }
  }
  walk(root as Y.Map<unknown>, '')
  return out.sort()
}

export function getOrAskConfig(LOCAL_STORAGE_KEY = APP_LOCAL_STORAGE_KEY, saveToLocalStorage = true) {
  const ASK = Symbol('ask')

  let config: symbol | (string | symbol)[] = ASK
  //let default = [ASK, ASK, ASK]
  //let default = ['TODO.com', ASK, ASK]
  //let default = ['TODO.com', 'todo-doc', 'todo-tok-suffix'] // TODO: server, document name, token (if any)

  if (LOCAL_STORAGE_KEY ?? '' !== '') {
    if (LOCAL_STORAGE_KEY == 'yjsapp-config') {
      alert(
        'WARNING: Using default config\n\nPlease configure your app with a unique local storage key.\n\n(if not, two apps might reuse the same credentials to the same document (but treat this as different type!).',
      )
      alert("We recommend to use a unique key, e.g. 'yjsapp-<your-app-name>', but will let you continue now.")
    }
    const local = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (local) {
      config = local.split(SEP)
    }
  }

  if (config == ASK) {
    const v = prompt(`[${LOCAL_STORAGE_KEY}]\n\nEnter the doc description e.g.: ${EG_CONFIG}`)
    if (!v) {
      throw new Error('No config provided')
    }
    config = v.split(SEP)
    if (config.length < 3 || config.length > 4) {
      throw new Error('Invalid config provided')
    }
    if (config.length === 3) {
      config.push(DEFAULT_BOX_PATH)
    }
  }
  if (!Array.isArray(config)) {
    throw new Error('Invalid config provided')
  }
  if (config[0] == ASK) {
    const server = prompt('[${LOCAL_STORAGE_KEY}]\n\nEnter the server name, e.g.: todo.com')
    if (!server) {
      throw new Error('No server provided')
    }
    config[0] = server
  }
  if (config[1] == ASK) {
    const docname = prompt('[${LOCAL_STORAGE_KEY}]\n\nEnter the document name, e.g.: todo-doc')
    if (!docname) {
      throw new Error('No document name provided')
    }
    config[1] = docname
  }
  if (config[2] == ASK) {
    const token = prompt('[${LOCAL_STORAGE_KEY}]\n\nEnter the token, e.g.: todo-tok-suffix')
    if (!token) {
      throw new Error('No token provided')
    }
    config[2] = token
  }
  if (config.length < 4) {
    config.push(DEFAULT_BOX_PATH)
  }
  if (config[3] == ASK || (typeof config[3] !== 'string') || (config[3] as string).trim() === '') {
    const boxPath = prompt('[${LOCAL_STORAGE_KEY}]\n\nEnter the box path, e.g.: BOX/@/shop.yaml')
    if (!boxPath) {
      throw new Error('No box path provided')
    }
    config[3] = boxPath
  }
  if (saveToLocalStorage) {
    localStorage.setItem(LOCAL_STORAGE_KEY, config.join(SEP))
  }
  return config as [string, string, string, string]
}

export function setupYjs({ websocket = true, indexeddb = true } = {}) {
  const ydoc = new Y.Doc()
  const [server, docname, token, boxPath] = getOrAskConfig()
  const idbkey = `yjs-box-${docname}` // idb key, can be different
  const provider = websocket
    ? new WebsocketProvider(server.includes('://') ? server : `wss://${server}`, `${docname}?t=${token}`, ydoc)
    : null
  const persistence = indexeddb ? new IndexeddbPersistence(idbkey, ydoc) : null
  // NOTE: the file node itself is resolved/created lazily by the store AFTER
  // providers sync. Creating it here would race the loading filesystem
  // (distinct node ids, children-key LWW) and could orphan stored content.
  // Resolves once persisted + server state has loaded (or timed out, so
  // offline startup is never blocked). Only then may content be written.
  const whenPersisted = persistence ? persistence.whenSynced : Promise.resolve()
  const whenConnected = provider
    ? new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (!done) {
            done = true
            resolve()
          }
        }
        provider.on('sync', (synced: boolean) => {
          if (synced) finish()
        })
        setTimeout(finish, 4000)
      })
    : Promise.resolve()
  const whenReady = Promise.all([whenPersisted, whenConnected]).then(() => {})
  return { ydoc, boxPath, provider, whenReady }
}
