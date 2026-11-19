/**
 * Five-field cron parsing and matching, dependency-free.
 *
 * Supports the subset a task board needs: `*`, numbers, ranges `a-b`, lists
 * `a,b,c`, steps `*​/15` and `a-b/5`, plus the usual three-letter names for
 * months and weekdays. Day-of-month and day-of-week combine the way cron does
 * (when both are restricted, either one matching is enough).
 */

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

const RANGES = [
  { field: 'minute', min: 0, max: 59 },
  { field: 'hour', min: 0, max: 23 },
  { field: 'dayOfMonth', min: 1, max: 31 },
  { field: 'month', min: 1, max: 12 },
  { field: 'dayOfWeek', min: 0, max: 6 },
]

function fail(message) {
  return Object.assign(new Error(`invalid cron expression: ${message}`), { code: 'invalid-cron' })
}

function named(value, field) {
  const upper = String(value).toUpperCase()
  if (field === 'month') {
    const index = MONTH_NAMES.indexOf(upper)
    return index === -1 ? null : index + 1
  }
  if (field === 'dayOfWeek') {
    const index = DAY_NAMES.indexOf(upper)
    if (index !== -1) return index
    if (upper === 'SUN') return 0
  }
  return null
}

function toNumber(token, spec) {
  const asName = named(token, spec.field)
  if (asName !== null) return asName
  if (/^\d+$/.test(token) === false) throw fail(`"${token}" is not a number in the ${spec.field} field`)
  const value = Number(token)
  if (value < spec.min || value > spec.max) {
    throw fail(`${value} is out of range ${spec.min}-${spec.max} for ${spec.field}`)
  }
  return value
}

function expandField(text, spec) {
  const set = new Set()
  for (const part of String(text).split(',')) {
    const chunk = part.trim()
    if (chunk === '') throw fail(`empty ${spec.field} entry`)
    const [rangePart, stepPart] = chunk.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (Number.isFinite(step) === false || step <= 0) throw fail(`bad step in "${chunk}"`)
    let from
    let to
    if (rangePart === '*') {
      from = spec.min
      to = spec.max
    } else if (rangePart.includes('-')) {
      const [start, end] = rangePart.split('-')
      from = toNumber(start, spec)
      to = toNumber(end, spec)
      if (from > to) throw fail(`range "${rangePart}" is inverted`)
    } else {
      from = toNumber(rangePart, spec)
      to = stepPart === undefined ? from : spec.max
    }
    for (let value = from; value <= to; value += step) set.add(value)
  }
  if (set.size === 0) throw fail(`empty ${spec.field} field`)
  return set
}

/**
 * Parse a cron expression into sets.
 * @param {string} expression five space-separated fields.
 */
export function parseCron(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/)
  if (fields.length !== 5) throw fail(`expected 5 fields, got ${fields.length}`)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  return {
    expression: String(expression).trim(),
    minutes: expandField(minute, RANGES[0]),
    hours: expandField(hour, RANGES[1]),
    daysOfMonth: expandField(dayOfMonth, RANGES[2]),
    months: expandField(month, RANGES[3]),
    daysOfWeek: expandField(dayOfWeek, RANGES[4]),
    domRestricted: dayOfMonth.trim() !== '*',
    dowRestricted: dayOfWeek.trim() !== '*',
  }
}

/** Does this minute match? `date` is a JS Date (local time). */
export function cronMatches(spec, date) {
  const parsed = typeof spec === 'string' ? parseCron(spec) : spec
  if (parsed.minutes.has(date.getMinutes()) === false) return false
  if (parsed.hours.has(date.getHours()) === false) return false
  if (parsed.months.has(date.getMonth() + 1) === false) return false
  const domHit = parsed.daysOfMonth.has(date.getDate())
  const dowHit = parsed.daysOfWeek.has(date.getDay())
  if (parsed.domRestricted && parsed.dowRestricted) return domHit || dowHit
  if (parsed.domRestricted) return domHit
  if (parsed.dowRestricted) return dowHit
  return true
}

/**
 * Next matching minute strictly after `fromMs`, or null within the horizon.
 * @param {string|object} spec cron expression or parsed spec.
 * @param {number} fromMs epoch ms.
 * @param {number} horizonMs how far to look ahead (default 366 days).
 */
export function nextCronRun(spec, fromMs, horizonMs = 366 * 24 * 60 * 60 * 1000) {
  const parsed = typeof spec === 'string' ? parseCron(spec) : spec
  const start = new Date(Math.floor(fromMs / 60000) * 60000 + 60000)
  const limit = start.getTime() + horizonMs
  // Walk forward; skip whole days when the date cannot match at all.
  let cursor = start
  while (cursor.getTime() <= limit) {
    if (parsed.months.has(cursor.getMonth() + 1) === false) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 0, 0, 0, 0)
      continue
    }
    if (cronMatches(parsed, cursor)) return cursor.getTime()
    cursor = new Date(cursor.getTime() + 60000)
  }
  return null
}

/** Human-readable next run, for the panel. */
export function describeCron(expression) {
  try {
    const spec = parseCron(expression)
    return { ok: true, expression: spec.expression }
  } catch (error) {
    return { ok: false, expression: String(expression ?? ''), error: error.message }
  }
}