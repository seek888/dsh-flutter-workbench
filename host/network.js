/**
 * Network request store fed by the Dart VM Service HTTP profile.
 *
 * `dart:io` only records requests after
 * `ext.dart.io.httpEnableTimelineLogging {enabled:'true'}` (vmservice.connect
 * does that best-effort), and the profile list holds *refs* — headers and timing
 * but no bodies. This store:
 *
 *  - pulls `vm.httpProfile()` on demand and on a timer while a run is live,
 *    forwarding the previous profile timestamp as the `updatedSince` cursor so
 *    the payload stays O(delta) (verified against a real VM service);
 *  - dedupes by the SDK request id (a request is re-reported when it completes,
 *    so the stored row is updated in place instead of duplicated);
 *  - keeps a bounded ring (default 2000 rows) with a monotonic cursor so a
 *    polling client can resume with `since`;
 *  - answers the §5.5 query shape, including `4xx`/`5xx` range filters and
 *    `error` (failed request or >= 400);
 *  - `detail()` fetches bodies through `getHttpProfileRequest` and reports
 *    `truncated` / `requestBodyTruncated` / `responseBodyTruncated` — bodies are
 *    never silently cut.
 *
 * Public surface: docs/CONTRACTS.md §5.5.
 */
import { clamp, nowMs, normalizeError } from './util.js'

export const NET_CAPACITY_DEFAULT = 2000
const MIN_AUTO_REFRESH_MS = 250
const MAX_AUTO_REFRESH_MS = 60000

function keyOf(entry) {
  return `${entry.runId ?? ''}\u0000${entry.isolateId ?? ''}\u0000${entry.id}`
}

function toStatusFilter(status) {
  if (status === undefined || status === null) return null
  const text = String(status).trim().toLowerCase()
  if (text === '' || text === 'all' || text === '*') return null
  if (text === 'error' || text === 'errors' || text === 'failed') return 'error'
  const range = /^([1-5])xx$/.exec(text)
  if (range !== null) return { min: Number(range[1]) * 100, max: Number(range[1]) * 100 + 99 }
  const exact = Number(text)
  return Number.isFinite(exact) ? { min: exact, max: exact } : null
}

function isFailure(entry) {
  if (entry?.error !== null && entry?.error !== undefined) return true
  const status = entry?.status
  return typeof status !== 'number' || status >= 400
}

function compilePattern(pattern) {
  if (pattern === undefined || pattern === null) return null
  const text = String(pattern)
  if (text.trim() === '') return null
  try {
    return new RegExp(text, 'i')
  } catch {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

/**
 * @param {{ vm?:any, logs?:any, bus?:any, settings?:any, logger?:any, capacity?:number,
 *   autoRefresh?:boolean, retentionMs?:number }} [options]
 */
export function createNetworkStore({ vm = null, logs = null, bus = null, settings = null, logger = null, capacity = NET_CAPACITY_DEFAULT, autoRefresh = true } = {}) {
  const limit = clamp(Number(capacity) || NET_CAPACITY_DEFAULT, 100, 20000)
  /** @type {Map<string, {seq:number, entry:any}>} */
  const rows = new Map()
  /** @type {Map<string, string>} newest key per SDK request id */
  const byRequestId = new Map()
  const order = []
  let seq = 0
  let sinceId = null
  let inFlight = false
  let lastError = null
  let lastRefreshAt = null
  let lastAdded = 0
  let autoTimer = null
  let autoIntervalMs = null
  const disposers = []

  function touchOrder(key) {
    order.push(key)
    while (rows.size > limit && order.length > 0) {
      const victim = order.shift()
      const record = rows.get(victim)
      if (record === undefined) continue
      rows.delete(victim)
      if (byRequestId.get(String(record.entry.id)) === victim) {
        byRequestId.delete(String(record.entry.id))
        // Re-point the id to the newest surviving row carrying it, if any.
        for (let index = order.length - 1; index >= 0; index -= 1) {
          const candidate = rows.get(order[index])
          if (candidate !== undefined && String(candidate.entry.id) === String(record.entry.id)) {
            byRequestId.set(String(record.entry.id), order[index])
            break
          }
        }
      }
    }
  }

  function ingestEntry(entry) {
    if (entry === null || entry === undefined || entry.id === undefined || entry.id === null) return { added: false, entry: null }
    const requestId = String(entry.id)
    const key = keyOf(entry)
    const existingKey = rows.has(key) ? key : byRequestId.get(requestId)
    const existing = existingKey === undefined ? undefined : rows.get(existingKey)
    if (existing !== undefined) {
      // Same request reported again (e.g. the response finished): update in place.
      const merged = { ...existing.entry }
      for (const [field, value] of Object.entries(entry)) {
        if (value !== undefined) merged[field] = value
      }
      existing.entry = merged
      byRequestId.set(requestId, existingKey)
      return { added: false, entry: merged }
    }
    const stored = { ...entry, id: requestId }
    const record = { seq: (seq += 1), entry: stored }
    rows.set(key, record)
    byRequestId.set(requestId, key)
    touchOrder(key)
    return { added: true, entry: stored, seq: record.seq }
  }

  function logNewEntries(created) {
    for (const entry of created) {
      // A row first seen while the request is still in flight has no status yet;
      // do not report those as failures (they are logged once they complete).
      if (entry.complete === false) continue
      const failed = isFailure(entry)
      if (!failed) continue
      const level = entry.error !== null && entry.error !== undefined ? 'error' : entry.status >= 500 ? 'error' : 'warn'
      const text = `${String(entry.method ?? 'GET')} ${String(entry.uri ?? '')} → ${entry.status ?? 'ERR'}${entry.error !== null && entry.error !== undefined ? ` (${entry.error})` : ''}`
      try {
        logs?.append?.({
          runId: entry.runId ?? null,
          projectId: null,
          source: 'network',
          level,
          text,
          meta: { id: entry.id, method: entry.method ?? null, status: entry.status ?? null, host: entry.host ?? null, durationMs: entry.durationMs ?? null },
        })
      } catch {
        /* logging is best effort */
      }
    }
  }

  /**
   * Pull the profile and merge it. `sinceId` is maintained internally; callers
   * only pass `runId` (contract) but an explicit `sinceId` is honoured for
   * one-shot deep reads.
   */
  async function refresh({ runId, sinceId: explicitSince, force = false } = {}) {
    if (vm === null || typeof vm.httpProfile !== 'function') {
      return { ok: false, added: 0, total: rows.size, nextCursor: seq, error: { code: 'no-vm', message: 'VM service is not available' } }
    }
    if (inFlight && force !== true) {
      return { ok: false, added: 0, skipped: true, total: rows.size, nextCursor: seq, error: { code: 'in-flight', message: 'an HTTP profile pull is already running' } }
    }
    inFlight = true
    try {
      const cursor = explicitSince ?? sinceId
      const profile = await vm.httpProfile({ runId, sinceId: cursor ?? undefined })
      lastRefreshAt = nowMs()
      if (profile === null || profile === undefined || profile.ok === false) {
        lastError = profile?.error ?? { code: 'profile-failed', message: 'HTTP profile pull failed' }
        return { ok: false, added: 0, total: rows.size, nextCursor: seq, error: lastError }
      }
      const created = []
      let added = 0
      for (const entry of Array.isArray(profile.entries) ? profile.entries : []) {
        const result = ingestEntry(entry)
        if (result.added) {
          added += 1
          created.push(result.entry)
        }
      }
      if (profile.nextSinceId !== undefined && profile.nextSinceId !== null) sinceId = String(profile.nextSinceId)
      lastAdded = added
      lastError = null
      if (created.length > 0) {
        logNewEntries(created)
        try {
          bus?.emit?.('network:entries', {
            runId: runId ?? null,
            added,
            entries: created,
            nextCursor: seq,
          })
        } catch {
          /* ignore */
        }
      }
      return {
        ok: true,
        added,
        total: rows.size,
        nextCursor: seq,
        nextSinceId: sinceId,
        method: profile.method ?? null,
        fetched: Array.isArray(profile.entries) ? profile.entries.length : 0,
      }
    } catch (error) {
      const normalized = normalizeError(error)
      lastError = { code: normalized.code, message: normalized.message }
      logger?.warn?.(`network: profile pull failed: ${normalized.message}`)
      return { ok: false, added: 0, total: rows.size, nextCursor: seq, error: lastError }
    } finally {
      inFlight = false
    }
  }

  /** §5.5 query: newest-first scan with filters, returned oldest→newest. */
  function query(options = {}) {
    const since = Number.isFinite(Number(options.since)) ? Math.max(0, Number(options.since)) : 0
    const take = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(2000, Number(options.limit))) : 200
    const statusFilter = toStatusFilter(options.status)
    const errorsOnly = options.errorsOnly === true || statusFilter === 'error'
    const method = options.method === undefined || options.method === null ? null : String(options.method).trim().toUpperCase()
    const host = options.host === undefined || options.host === null ? null : String(options.host).trim().toLowerCase()
    const runId = options.runId === undefined || options.runId === null ? null : String(options.runId)
    const pattern = compilePattern(options.pattern)

    const result = []
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const record = rows.get(order[index])
      if (record === undefined) continue
      if (record.seq <= since) continue
      const entry = record.entry
      if (runId !== null && String(entry.runId ?? '') !== runId) continue
      if (method !== null && String(entry.method ?? '').toUpperCase() !== method) continue
      if (host !== null && String(entry.host ?? '').toLowerCase().includes(host) === false) continue
      if (errorsOnly) {
        if (!isFailure(entry)) continue
      } else if (statusFilter !== null) {
        const status = entry.status
        if (typeof status !== 'number' || status < statusFilter.min || status > statusFilter.max) continue
      }
      if (pattern !== null && pattern.test(String(entry.uri ?? '')) === false) continue
      result.push(entry)
      if (result.length >= take) break
    }
    result.reverse()
    return { entries: result, nextCursor: seq, total: rows.size }
  }

  /** Headers + bodies for one request, with explicit truncation flags. */
  async function detail({ id, runId, maxBodyBytes } = {}) {
    const requestId = id === undefined || id === null ? '' : String(id)
    if (requestId === '') {
      throw Object.assign(new Error('detail() needs { id }'), { code: 'bad-request' })
    }
    let key = byRequestId.get(requestId)
    if (key !== undefined && runId !== undefined && runId !== null) {
      const record = rows.get(key)
      if (record !== undefined && String(record.entry.runId ?? '') !== String(runId)) {
        // Prefer the row belonging to the requested run when several runs are stored.
        for (let index = order.length - 1; index >= 0; index -= 1) {
          const candidate = rows.get(order[index])
          if (candidate !== undefined && String(candidate.entry.id) === requestId && String(candidate.entry.runId ?? '') === String(runId)) {
            key = order[index]
            break
          }
        }
      }
    }
    const record = key === undefined ? undefined : rows.get(key)
    if (record === undefined) {
      throw Object.assign(new Error(`unknown network request id: ${requestId}`), { code: 'not-found', id: requestId })
    }
    const entry = record.entry
    if (vm === null || typeof vm.httpRequestDetail !== 'function') {
      throw Object.assign(new Error('VM service is not available'), { code: 'no-vm' })
    }
    let payload
    try {
      payload = await vm.httpRequestDetail({
        requestId: entry.id,
        runId: entry.runId ?? undefined,
        isolateId: entry.isolateId ?? undefined,
        maxBodyBytes,
      })
    } catch (error) {
      const normalized = normalizeError(error)
      throw Object.assign(new Error(`network detail failed: ${normalized.message}`), {
        code: normalized.code === 'error' ? 'detail-failed' : normalized.code,
        id: requestId,
        cause: error,
      })
    }
    // Fold the fresh byte counts / headers back into the row so the list improves.
    const merged = { ...entry }
    if (payload.status !== null && payload.status !== undefined) merged.status = payload.status
    if (payload.requestHeaders !== null && payload.requestHeaders !== undefined) merged.requestHeaders = payload.requestHeaders
    if (payload.responseHeaders !== null && payload.responseHeaders !== undefined) merged.responseHeaders = payload.responseHeaders
    if (payload.requestBodyBytes !== null && payload.requestBodyBytes !== undefined) merged.requestBytes = payload.requestBodyBytes
    if (payload.responseBodyBytes !== null && payload.responseBodyBytes !== undefined) merged.responseBytes = payload.responseBodyBytes
    if (payload.durationMs !== null && payload.durationMs !== undefined) merged.durationMs = payload.durationMs
    merged.complete = payload.complete === true || merged.complete === true
    record.entry = merged
    return {
      ...payload,
      id: requestId,
      runId: entry.runId ?? null,
      host: entry.host ?? null,
      path: entry.path ?? null,
      at: entry.at ?? null,
    }
  }

  function clear() {
    rows.clear()
    byRequestId.clear()
    order.length = 0
    sinceId = null
    lastError = null
    lastAdded = 0
  }

  function counts() {
    const byStatusClass = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, error: 0, other: 0 }
    let durationTotal = 0
    let withDuration = 0
    for (const record of rows.values()) {
      const entry = record.entry
      if (entry.error !== null && entry.error !== undefined) byStatusClass.error += 1
      const status = entry.status
      if (typeof status === 'number' && status >= 100 && status < 600) byStatusClass[`${Math.floor(status / 100)}xx`] += 1
      else if (entry.error === null || entry.error === undefined) byStatusClass.other += 1
      if (typeof entry.durationMs === 'number') {
        durationTotal += entry.durationMs
        withDuration += 1
      }
    }
    return {
      total: rows.size,
      capacity: limit,
      cursor: seq,
      byStatusClass,
      failures: byStatusClass.error + byStatusClass['4xx'] + byStatusClass['5xx'],
      avgDurationMs: withDuration === 0 ? 0 : Math.round((durationTotal / withDuration) * 100) / 100,
      lastError,
      lastRefreshAt,
      lastAdded,
      autoIntervalMs,
      sinceId,
    }
  }

  // --- timer ---------------------------------------------------------------
  function resolveInterval(intervalMs) {
    const fromSettings = settings?.get?.()?.networkAutoRefreshMs
    const value = Number(intervalMs ?? fromSettings ?? 1500)
    return clamp(Number.isFinite(value) ? value : 1500, MIN_AUTO_REFRESH_MS, MAX_AUTO_REFRESH_MS)
  }

  function startAutoRefresh({ intervalMs } = {}) {
    stopAutoRefresh()
    autoIntervalMs = resolveInterval(intervalMs)
    autoTimer = setInterval(() => {
      const connected = typeof vm?.isConnected === 'function' ? vm.isConnected() : true
      if (!connected) return
      refresh({}).catch((error) => logger?.debug?.(`network: auto refresh failed: ${normalizeError(error).message}`))
    }, autoIntervalMs)
    if (typeof autoTimer.unref === 'function') autoTimer.unref()
    // Pull once immediately so the panel is not empty for a full interval.
    refresh({}).catch(() => {})
    return autoIntervalMs
  }

  function stopAutoRefresh() {
    if (autoTimer !== null) {
      clearInterval(autoTimer)
      autoTimer = null
    }
    autoIntervalMs = null
  }

  // --- bus wiring ----------------------------------------------------------
  if (bus !== null && typeof bus?.on === 'function') {
    disposers.push(
      bus.on('vm:connected', () => {
        if (autoRefresh) startAutoRefresh({})
      }),
    )
    disposers.push(
      bus.on('vm:disconnected', () => {
        stopAutoRefresh()
      }),
    )
    disposers.push(
      bus.on('run:state', (state) => {
        const phase = String(state?.phase ?? '')
        if (phase === 'stopped' || phase === 'failed' || phase === 'exited') stopAutoRefresh()
      }),
    )
  }

  return {
    capacity: limit,
    refresh,
    query,
    detail,
    clear,
    counts,
    startAutoRefresh,
    stopAutoRefresh,
    /** Cursor of the newest stored row (`query().nextCursor`). */
    cursor: () => seq,
    size: () => rows.size,
    lastError: () => lastError,
    dispose() {
      stopAutoRefresh()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      clear()
    },
  }
}

export default createNetworkStore