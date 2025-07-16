export type Data = {
  count: number
  lists: Record<string, Item[]>
}

export type State = 'checked' | 'unchecked' | 'archived'

export type Item = {
  description: string
  state: State
}

