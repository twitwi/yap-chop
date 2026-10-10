import { enumSpec } from '@/repair'

export type Data = {
  lists: Record<string, Item[]>
}

// Single source for the state domain: the value array drives the TS type,
// the validity check, and the repair (priority = array order, so
// 'unchecked' wins divergent races — shopping-safe: a lost 'checked' gets
// re-tapped, a lost 'unchecked' means a missed purchase).
export const STATE_VALUES = ['unchecked', 'checked', 'archived'] as const
export type State = typeof STATE_VALUES[number]
export const StateSpec = enumSpec(STATE_VALUES, 'unchecked')

export type Item = {
  id: string
  description: string
  state: State
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}
