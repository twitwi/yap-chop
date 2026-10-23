import * as Y from 'yjs'
import {
  SEP,
  getFileText,
  listBoxFiles,
  parseConfig,
  setupYjs as setupConnection,
  splitBoxPath,
} from 'yjs-boxtools'

export { SEP }
export { listBoxFiles }
export const EG_CONFIG = `todo.com${SEP}doc${SEP}token${SEP}BOX/@/shop.yaml`

export const APP_LOCAL_STORAGE_KEY = 'yap-chop:server'

// Box layout: the 4th config element is a full in-box file path, e.g.
// "BOX/@/shop.yaml". "@" opens the box — BOX is a Y.Map under the doc root
// holding a virtual filesystem (see yjs-boxtools) — and "shop.yaml" is the
// file inside it. Only the exact "/@/" segment is reserved.
export const DEFAULT_BOX_PATH = `BOX/@/shop.yaml`

// Resolve the file's live Y.Text. Never creates unless asked — callers must
// only pass create=true after providers sync (see setupYjs().whenReady), or
// concurrent creations orphan each other (distinct node ids, LWW on the
// name key).
export function resolveFileText(ydoc: Y.Doc, fullPath: string, create = false): Y.Text | undefined {
  return getFileText(ydoc, fullPath, create) ?? undefined
}

export function getOrAskConfig(LOCAL_STORAGE_KEY = APP_LOCAL_STORAGE_KEY, saveToLocalStorage = true) {
  const ASK = Symbol('ask')

  let config: symbol | (string | symbol)[] = ASK

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
  if (config[3] == ASK || typeof config[3] !== 'string' || (config[3] as string).trim() === '') {
    const boxPath = prompt('[${LOCAL_STORAGE_KEY}]\n\nEnter the box path, e.g.: BOX/@/shop.yaml')
    if (!boxPath) {
      throw new Error('No box path provided')
    }
    config[3] = boxPath
  }
  // Validated structurally by the pure parser (throws on malformed input)...
  const parsed = parseConfig((config as string[]).join(SEP), DEFAULT_BOX_PATH)
  // ...and the 4th element must be a real in-box path ("BOX/@/shop.yaml").
  // Without this a bad saved config would throw deep in the store's first
  // resolution instead of failing here with an actionable message.
  try {
    splitBoxPath(parsed.boxPath)
  } catch {
    throw new Error(`Invalid box path (need "<box>/@/<file>"): ${parsed.boxPath}`)
  }
  if (saveToLocalStorage) {
    localStorage.setItem(LOCAL_STORAGE_KEY, [parsed.server, parsed.docname, parsed.token, parsed.boxPath].join(SEP))
  }
  return [parsed.server, parsed.docname, parsed.token, parsed.boxPath] as [string, string, string, string]
}

export function setupYjs({ websocket = true, indexeddb = true } = {}) {
  const [server, docname, token, boxPath] = getOrAskConfig()
  // NOTE: the file node itself is resolved/created lazily by the store AFTER
  // providers sync. Creating it here would race the loading filesystem
  // (distinct node ids, children-key LWW) and could orphan stored content.
  // whenReady fires once persisted + server state has loaded (or timed out,
  // so offline startup is never blocked). Only then may content be written.
  const { ydoc, provider, whenReady } = setupConnection(
    { server, docname, token, boxPath },
    { websocket, indexeddb, idbKey: `yjs-box-${docname}` },
  )
  return { ydoc, boxPath, provider, whenReady }
}
