import * as Y from 'yjs'
import type { YAny } from './ytools'
import { ensureYMap } from './ytools'

export const SEP = '::'
export const EG_CONFIG_NOBOX = `todo.com${SEP}doc${SEP}token${SEP}sub/folder`
export const EG_CONFIG_BOX = `todo.com${SEP}doc${SEP}token${SEP}sub/folder/@/path`
export const ROOT_ID = 'root:'

export function getYMap(doc: Y.Doc, path: string): Y.Map<unknown> | undefined {
  const steps = path.split('/').filter((s) => s)
  if (steps.length === 0) {
    const rootMap = doc.getMap()
    return rootMap as Y.Map<unknown>
  }
  let p = doc.getMap() as Y.Map<unknown>
  for (let i = 0; i < steps.length - 1; i++) {
    const k = steps[i]
    if (k === '@') {
      return p
    }
    if (!p.has(k)) return undefined
    const next = p.get(k)
    if (!(next instanceof Y.Map)) return undefined
    p = next
  }
  const last = steps[steps.length - 1]
  if (last === '@') return p
  if (!p.has(last)) return undefined
  const lastVal = p.get(last)
  return lastVal instanceof Y.Map ? lastVal : undefined
}

export function hasYText(doc: Y.Doc, path: string, create: boolean = false): boolean {
  try {
    const result = getYText(doc, path, create)
    return result !== undefined
  } catch {
    return false
  }
}

export function getYText(doc: Y.Doc, path: string, create: boolean = false): Y.Text | undefined {
  const steps = path.split('/').filter((s) => s)
  if (steps.length === 0) throw new Error('Path cannot be empty')
  if (steps.length === 1) {
    const k = steps[0]
    if (create && !doc.getText(k)) {
      doc.getText(k)
    }
    return doc.getText(k) || undefined
  }
  let p = doc.getMap() as Y.Map<unknown>
  while (steps.length > 1) {
    const k = steps.shift()!
    if (k === '@') {
      return getYTextInBox(p, steps.join('/'), create)
    }
    if (!p.has(k)) {
      if (create) {
        p.set(k, new Y.Map())
      } else {
        return undefined
      }
    }
    const next = p.get(k)
    if (!(next instanceof Y.Map)) return undefined
    p = next
  }
  const k = steps.shift()!
  if (!p.has(k)) {
    if (create) {
      const text = new Y.Text()
      p.set(k, text)
      return text
    }
    return undefined
  }
  const val = p.get(k)
  return val instanceof Y.Text ? (val as Y.Text) : undefined
}

export function getYBoxFor(doc: Y.Doc, path: string): Y.Map<any> | undefined {
  const steps = path.split('/').filter((s) => s)
  if (steps.length < 2) return undefined
  let p = doc.getMap()
  while (steps.length > 0) {
    const k = steps.shift()!
    if (k === '@') {
      return p
    }
    if (!p.has(k)) return undefined
    const next = p.get(k)
    if (!(next instanceof Y.Map)) return undefined
    p = next
  }
  return undefined
}

export function getYTextInBox(box: Y.Map<unknown>, path: string, create: boolean = false): Y.Text | undefined {
  const steps = path.split('/').filter((s) => s)
  if (steps.length === 0) throw new Error('Path cannot be empty')
  if (!box.has(ROOT_ID)) {
    if (!create) return undefined
    const t = Date.now()
    const root = new Y.Map<unknown>()
    root.set('type', 'directory')
    root.set('parent', '')
    root.set('ctime', t)
    root.set('mtime', t)
    root.set('children', new Y.Map<string>())
    box.set(ROOT_ID, root)
  }
  const rootRaw = box.get(ROOT_ID)
  if (!(rootRaw instanceof Y.Map)) return undefined
  let p = rootRaw as Y.Map<unknown>
  let pid = ROOT_ID

  while (steps.length > (create ? 1 : 0)) {
    const k = steps.shift()!
    if (p.get('type') !== 'directory') return undefined
    const children = p.get('children')
    if (!(children instanceof Y.Map)) return undefined
    const childrenMap = children as Y.Map<string>
    const subk = childrenMap.get(k)
    if (!subk) {
      if (!create) return undefined
      const dir = new Y.Map<unknown>()
      const t = Date.now()
      dir.set('type', 'directory')
      dir.set('parent', pid)
      dir.set('ctime', t)
      dir.set('mtime', t)
      dir.set('children', new Y.Map<string>())
      const newId = _generateId()
      box.set(newId, dir)
      childrenMap.set(k, newId)
      p = dir
      pid = newId
    } else {
      const subNode = box.get(subk)
      if (!(subNode instanceof Y.Map)) return undefined
      p = subNode as Y.Map<unknown>
      pid = subk
    }
  }
  if (create) {
    const k = steps.shift()!
    if (p.get('type') !== 'directory') return undefined
    const children = p.get('children')
    if (!(children instanceof Y.Map)) return undefined
    const childrenMap = children as Y.Map<string>
    const subk = childrenMap.get(k)
    if (subk) {
      throw new Error(`Path already exists at ${k}`)
    }
    const newId = _generateId()
    const t = Date.now()
    const newFile = new Y.Map<unknown>()
    newFile.set('type', 'text')
    newFile.set('parent', pid)
    newFile.set('ctime', t)
    newFile.set('mtime', t)
    const content = new Y.Text()
    newFile.set('content', content)
    childrenMap.set(k, newId)
    box.set(newId, newFile)
    return content
  } else {
    if (p.get('type') !== 'text') return undefined
    const content = p.get('content')
    return content instanceof Y.Text ? (content as Y.Text) : undefined
  }
}

export function _generateId(): string {
  return 'id:' + Math.random().toString(36).slice(2, 10)
}
