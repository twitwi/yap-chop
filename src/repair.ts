// Generic stateless repair for constrained fields stored in merged Y.Text.
//
// Background: concurrent same-position replacements in CRDT text do not
// converge — both inserts survive ("uncheckedunchecked"), even for identical
// edits. Such garbles are almost always *invalid* values (concatenations of
// valid ones), so every peer can repair them deterministically from the text
// alone: same bytes -> same result, on every peer and every reload, with no
// memory, no registry, no write-back. (Write-back must be avoided: two peers
// repairing by delete+insert would duplicate the repair itself. Garbled text
// self-heals the next time a genuine local edit rewrites that region.)
//
// A constrained field is described by a FieldSpec: a validity predicate plus
// a pure repair function. Free-text fields (e.g. item descriptions) have no
// describable validity and are out of scope by design — disjoint positional
// edits already merge correctly for them.
//
// Repair cascade (each stage only accepts what the token evidences):
// exact match -> whole-word concatenations -> affix-fragment stripping
// (partial-word inserts from humans typing into the file concurrently with
// whole-word writes, e.g. "un" surviving next to "unchecked") ->
// deterministic fallback, reached solely when nothing explains the token.

export interface FieldSpec<T> {
  valid(v: unknown): v is T
  repair(raw: unknown): T
}

// Enum spec: inclusion check + greedy longest-match split of the token.
// All pieces identical -> that value (recovers unanimous concurrent edits).
// Mixed pieces -> present piece with lowest index in `values`, so the array
// order doubles as the tie-break priority. Affix fragments (leading proper
// prefixes / trailing proper suffixes of valid values, from partial-word
// concurrent inserts) are stripped least-first before splitting; only a
// fully-explained remainder is accepted. Unsplittable -> fallback.
// Requires that no value is a proper prefix of another (asserted at
// construction); otherwise greedy splitting could misparse.
export function enumSpec<T extends string>(values: readonly T[], fallback: T): FieldSpec<T> {
  for (const a of values) {
    for (const b of values) {
      if (a !== b && b.startsWith(a)) {
        throw new Error(`enumSpec: value "${a}" is a proper prefix of "${b}" — greedy repair would be ambiguous`)
      }
    }
  }
  const order = new Map<string, number>(values.map((v, i) => [v, i]))
  const longestFirst = [...values].sort((a, b) => b.length - a.length)
  return {
    valid(v: unknown): v is T {
      return typeof v === 'string' && order.has(v)
    },
    repair(raw: unknown): T {
      if (typeof raw === 'string' && order.has(raw)) return raw as T
      if (typeof raw !== 'string') return fallback
      // Split a remainder greedily into valid words (exact: longest-match is
      // unambiguous here since no value is a proper prefix of another).
      // Returns null unless the remainder is FULLY explained, non-empty.
      const split = (s: string): T[] | null => {
        const pieces: T[] = []
        let rest = s
        while (rest.length > 0) {
          const hit = longestFirst.find((v) => rest.startsWith(v))
          if (hit === undefined) return null
          pieces.push(hit as T)
          rest = rest.slice(hit.length)
        }
        return pieces.length > 0 ? pieces : null
      }
      const pick = (pieces: T[]): T => {
        if (pieces.every((p) => p === pieces[0])) return pieces[0]
        return pieces.slice().sort((a, b) => order.get(a)! - order.get(b)!)[0]
      }
      // Candidate strip lengths: leading runs that are proper prefixes (and
      // trailing runs that are proper suffixes) of valid values. Such affix
      // fragments arise when a human types into the file (e.g. typing "un"
      // in front of "checked") concurrently with a whole-word write
      // elsewhere — the partial insert survives the other's delete, so the
      // token is fragment + value(s) + fragment rather than a clean
      // concatenation. Pairs are tried with least stripping first, so pure
      // whole-word concatenations resolve exactly as before.
      const leadLens: number[] = [0]
      const trailLens: number[] = [0]
      for (let i = 1; i < raw.length; i++) {
        const pre = raw.slice(0, i)
        if (longestFirst.some((v) => v.length > pre.length && v.startsWith(pre))) leadLens.push(i)
        const suf = raw.slice(raw.length - i)
        if (longestFirst.some((v) => v.length > suf.length && v.endsWith(suf))) trailLens.push(i)
      }
      const pairs: Array<[number, number]> = []
      for (const l of leadLens) {
        for (const r of trailLens) {
          if (l + r < raw.length) pairs.push([l, r])
        }
      }
      pairs.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0])
      for (const [l, r] of pairs) {
        const mid = raw.slice(l, raw.length - r)
        const pieces = split(mid)
        // Note: mid is never empty here (l + r < raw.length), so a split
        // result is always a non-empty, fully-explained piece list.
        if (pieces !== null) return pick(pieces)
      }
      return fallback
    },
  }
}

// Apply a specs record to a list of plain-object items, repairing invalid
// constrained fields in place. Adding a future field is one entry here, e.g.
// normalizeItems(items, { state: StateSpec, priority: PrioritySpec }).
// Free-text fields simply have no entry. Pure and side-effect free apart
// from the in-place repair (callers pass freshly parsed/cloned objects).
export function normalizeItems<TItem extends Record<string, unknown>>(
  items: TItem[],
  specs: { [K in keyof TItem]?: FieldSpec<TItem[K]> },
): void {
  for (const item of items) {
    for (const [field, spec] of Object.entries(specs) as Array<[keyof TItem, FieldSpec<TItem[keyof TItem]>]>) {
      if (!spec) continue
      const raw: unknown = item[field]
      if (!spec.valid(raw)) {
        item[field] = spec.repair(raw) as TItem[keyof TItem]
      }
    }
  }
}

export function normalizeLists<TLists extends Record<string, Array<Record<string, unknown>>>>(
  lists: TLists,
  specs: { [K in keyof TLists[string][number]]?: FieldSpec<TLists[string][number][K]> },
): void {
  for (const items of Object.values(lists)) {
    normalizeItems(items, specs)
  }
}
// Structural deep equality: objects compare key-order-insensitively,
// arrays order-sensitively. Used to decide whether the model holds anything
// the last-synced state doesn't (the publish condition). JSON.stringify
// comparison would be wrong here: parse/merge paths don't preserve key order.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ka = Object.keys(ao)
  const kb = Object.keys(bo)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]))
}

// Regex-constrained strings (e.g. a future `color: #[0-9a-f]{6}` field).
// Match -> value, else fallback. No splitting: partial garbles of short
// tokens cannot be attributed, so they fall back deterministically.
export function matchSpec(regex: RegExp, fallback: string): FieldSpec<string> {
  return {
    valid(v: unknown): v is string {
      return typeof v === 'string' && regex.test(v)
    },
    repair(raw: unknown): string {
      return typeof raw === 'string' && regex.test(raw) ? raw : fallback
    },
  }
}
