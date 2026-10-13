// Schedule (cron) triggers: a strict 5-field parser and the next run times in an IANA timezone, so the assistant can
// read the schedule back to the user before it goes live. eval is unavailable in MV3 service workers and the
// extension ships no cron library, so this is a small, dependency-free evaluator.
//
// Accepted syntax per field: *, ?, numbers, ranges (1-5), steps (*/15, 1-30/5, 5/10), lists (1,15,30), and English
// month / weekday names (JAN-DEC, SUN-SAT). Weekday 7 is Sunday. Quartz extensions (L, W, #) are refused: whether
// viaSocket's scheduler runs them is not known. When both day-of-month and weekday are restricted, a day matches
// either one (classic cron semantics).

export interface CronFields {
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  daysStar: boolean
  weekdaysStar: boolean
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week'] as const

interface FieldSpec {
  name: (typeof FIELD_NAMES)[number]
  min: number
  max: number
  names?: Record<string, number>
  question?: boolean
}

const SPECS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31, question: true },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS, question: true },
]

function parseValue(raw: string, spec: FieldSpec): number | string {
  const v = raw.toLowerCase()
  if (spec.names && Object.hasOwn(spec.names, v)) return spec.names[v] as number
  if (!/^\d{1,2}$/.test(v)) return `"${raw}" is not a valid ${spec.name}`
  const n = Number(v)
  if (n < spec.min || n > spec.max) return `${spec.name} ${n} is outside ${spec.min}-${spec.max}`
  return n
}

function parseField(text: string, spec: FieldSpec): { values: Set<number>; star: boolean } | string {
  if (/[LW#]/i.test(text.replace(/[a-z]{3}/gi, (m) => (spec.names && Object.hasOwn(spec.names, m.toLowerCase()) ? '' : m)))) {
    return `the ${spec.name} field uses L, W or #, which are not supported; use plain numbers, ranges, steps and lists`
  }
  if (text === '*' || (text === '?' && spec.question)) {
    const all = new Set<number>()
    for (let i = spec.min; i <= spec.max; i++) all.add(i)
    return { values: all, star: true }
  }
  const values = new Set<number>()
  for (const part of text.split(',')) {
    if (!part) return `the ${spec.name} field has an empty list item`
    const [base, stepText, extra] = part.split('/')
    if (extra !== undefined || base === undefined || base === '') return `"${part}" is not a valid ${spec.name}`
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) return `"${part}": the step after / must be a positive number`
      step = Number(stepText)
    }
    let from: number
    let to: number
    if (base === '*') {
      from = spec.min
      to = spec.max
    } else if (base.includes('-')) {
      const [a, b, more] = base.split('-')
      if (more !== undefined || a === undefined || b === undefined) return `"${part}" is not a valid ${spec.name} range`
      const fa = parseValue(a, spec)
      const fb = parseValue(b, spec)
      if (typeof fa === 'string') return fa
      if (typeof fb === 'string') return fb
      if (fa > fb) return `"${part}": a range must go from low to high`
      from = fa
      to = fb
    } else {
      const f = parseValue(base, spec)
      if (typeof f === 'string') return f
      from = f
      // "5/10" means from 5 to the end, every 10.
      to = stepText !== undefined ? spec.max : f
    }
    for (let i = from; i <= to; i += step) values.add(i)
  }
  return { values, star: false }
}

/** Parses a standard 5-field expression; returns a readable error otherwise. */
export function parseCron(expr: string): { ok: true; fields: CronFields } | { ok: false; error: string } {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5 || !parts[0]) {
    return { ok: false, error: `a cron expression has exactly 5 fields (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5"; got ${parts.filter(Boolean).length}` }
  }
  const parsed: Array<{ values: Set<number>; star: boolean }> = []
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i] as string, SPECS[i] as FieldSpec)
    if (typeof r === 'string') return { ok: false, error: r }
    parsed.push(r)
  }
  const [mi, h, dom, mon, dow] = parsed as [typeof parsed[0], typeof parsed[0], typeof parsed[0], typeof parsed[0], typeof parsed[0]]
  const weekdays = new Set([...dow.values].map((d) => (d === 7 ? 0 : d)))
  return {
    ok: true,
    fields: {
      minutes: [...mi.values].sort((a, b) => a - b),
      hours: [...h.values].sort((a, b) => a - b),
      days: dom.values,
      months: mon.values,
      weekdays,
      daysStar: dom.star,
      weekdaysStar: dow.star,
    },
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

/** True for a timezone name the runtime knows (IANA, e.g. "Asia/Kolkata", or "UTC"). */
export function validTimezone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return false
  try {
    partsFormatter(tz)
    return true
  } catch {
    return false
  }
}

interface Wall {
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
}

function wallTime(utcMs: number, tz: string): Wall {
  const out: Record<string, number> = {}
  for (const p of partsFormatter(tz).formatToParts(new Date(utcMs))) if (p.type !== 'literal') out[p.type] = Number(p.value)
  return { y: out.year ?? 0, m: out.month ?? 0, d: out.day ?? 0, h: (out.hour ?? 0) % 24, mi: out.minute ?? 0, s: out.second ?? 0 }
}

/** Offset of the timezone at an instant, in ms (wall clock minus UTC). */
function offsetAt(utcMs: number, tz: string): number {
  const w = wallTime(utcMs, tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000
}

/** The instant a wall-clock time happens in a timezone; null when it does not exist (a DST gap). */
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number | null {
  const asUtc = Date.UTC(y, m - 1, d, h, mi)
  const o1 = offsetAt(asUtc, tz)
  let guess = asUtc - o1
  const o2 = offsetAt(guess, tz)
  if (o2 !== o1) guess = asUtc - o2
  const w = wallTime(guess, tz)
  return w.y === y && w.m === m && w.d === d && w.h === h && w.mi === mi ? guess : null
}

function dayMatches(f: CronFields, y: number, m: number, d: number): boolean {
  if (!f.months.has(m)) return false
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  if (f.daysStar && f.weekdaysStar) return true
  if (f.daysStar) return f.weekdays.has(dow)
  if (f.weekdaysStar) return f.days.has(d)
  return f.days.has(d) || f.weekdays.has(dow)
}

/** The next `count` run instants after `from`, searching up to about four years ahead. */
export function nextRuns(fields: CronFields, tz: string, count = 5, from = Date.now()): number[] {
  const out: number[] = []
  const start = wallTime(from, tz)
  const day0 = Date.UTC(start.y, start.m - 1, start.d)
  for (let i = 0; i < 1500 && out.length < count; i++) {
    const day = new Date(day0 + i * 86_400_000)
    const y = day.getUTCFullYear()
    const m = day.getUTCMonth() + 1
    const d = day.getUTCDate()
    if (!dayMatches(fields, y, m, d)) continue
    for (const h of fields.hours) {
      if (i === 0 && h < start.h) continue
      for (const mi of fields.minutes) {
        if (i === 0 && h === start.h && mi <= start.mi) continue
        const at = zonedToUtc(y, m, d, h, mi, tz)
        if (at === null || at <= from) continue
        out.push(at)
        if (out.length >= count) return out
      }
    }
  }
  return out
}

const readable = new Map<string, Intl.DateTimeFormat>()

/** "Mon, 13 Oct 2026, 09:00" in the timezone, plus the ISO time with its offset. */
export function describeRun(utcMs: number, tz: string): { local: string; iso: string } {
  let f = readable.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    readable.set(tz, f)
  }
  const w = wallTime(utcMs, tz)
  const off = Math.round(offsetAt(utcMs, tz) / 60_000)
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  const pad = (n: number) => String(n).padStart(2, '0')
  const iso = `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return { local: f.format(new Date(utcMs)), iso }
}
