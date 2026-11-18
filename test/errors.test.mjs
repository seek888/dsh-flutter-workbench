/**
 * Unit tests for host/errors.js — exception parsing, fingerprinting and dedupe.
 *
 * All fixtures are real Flutter/Dart error shapes (the box-drawing header and
 * `The following … was thrown` line are what Flutter actually prints), so the
 * parser is exercised without Flutter running.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createErrorStore,
  errorFingerprint,
  normalizeMessage,
  parseExceptionText,
  parseFrames,
  repairFrames,
  splitExceptionBlocks,
} from '../host/errors.js'
import { createBus, parseStack } from '../host/util.js'

const WIDGETS_ERROR = [
  '══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞════════════════════════════════════',
  'The following StateError was thrown building ProbeApp(dirty, state: _ProbeAppState#96fa1):',
  'Bad state: nope',
  '',
  'The relevant error-causing widget was:',
  '  ProbeApp file:///C:/work/probe/lib/main.dart:12:16',
  '',
  'When the exception was thrown, this was the stack:',
  '#0      _ProbeAppState.build (package:probe/main.dart:20:5)',
  '#1      StatefulElement.build (package:flutter/src/widgets/framework.dart:5000:27)',
  '#2      ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:4913:15)',
  '════════════════════════════════════════════════════════════════════════════',
].join('\n')

const UNHANDLED = [
  'Unhandled exception:',
  'Bad state: boom',
  '#0      main (file:///C:/work/probe/bin/main.dart:7:3)',
  '#1      _startIsolate.<anonymous closure> (dart:isolate-patch/isolate_patch.dart:307:12)',
].join('\n')

test('parseExceptionText extracts message, exception, context and repaired frames', () => {
  const parsed = parseExceptionText(WIDGETS_ERROR, { kind: 'flutter' })
  assert.notEqual(parsed, null)
  assert.equal(parsed.kind, 'flutter')
  assert.equal(parsed.message, 'Bad state: nope')
  assert.match(parsed.exception, /^The following StateError was thrown building ProbeApp/)
  assert.equal(parsed.context, 'widgets library')
  assert.equal(parsed.frames.length, 3)
  assert.deepEqual(parsed.frames[0], {
    file: 'package:probe/main.dart',
    line: 20,
    column: 5,
    symbol: '_ProbeAppState.build',
  })
  assert.equal(parsed.frames[1].file, 'package:flutter/src/widgets/framework.dart')
  assert.equal(parsed.frames[1].line, 5000)
  assert.equal(parsed.frames[1].column, 27)
  assert.equal(parsed.handled, false)
  assert.equal(parsed.renders, 1)

  // Unhandled blocks keep the exception type out of the message.
  const unhandled = parseExceptionText(UNHANDLED, { kind: 'dart' })
  assert.equal(unhandled.kind, 'dart')
  assert.equal(unhandled.message, 'Bad state: boom')
  assert.equal(unhandled.frames.length, 2)
  assert.equal(unhandled.frames[0].file, 'file:///C:/work/probe/bin/main.dart')
  assert.equal(unhandled.frames[0].line, 7)
  assert.equal(unhandled.frames[0].column, 3)
  assert.equal(unhandled.frames[0].symbol, 'main')

  // A one-line error still produces a message (no frames).
  const single = parseExceptionText('Exception: something failed', { kind: 'dart' })
  assert.equal(single.message, 'Exception: something failed')
  assert.equal(single.frames.length, 0)

  // Plain info text is not an exception.
  assert.equal(parseExceptionText('flutter: building widgets'), null)
  assert.equal(parseExceptionText('   '), null)
})

test('parseStack repair fixes the package: split and derives symbols', () => {
  const stack = '#0      MyWidget.build (package:app/widgets/home.dart:42:9)'
  const raw = parseStack(stack)
  assert.equal(raw.length, 1)
  // util.parseStack shifts the column into `line` for package: URIs…
  assert.equal(raw[0].file, 'package:app/widgets/home.dart:42')
  assert.equal(raw[0].line, 9)
  // …the repair restores the real location and symbol.
  const repaired = repairFrames(raw, stack)
  assert.deepEqual(repaired[0], { file: 'package:app/widgets/home.dart', line: 42, column: 9, symbol: 'MyWidget.build' })
  assert.deepEqual(parseFrames(stack), repaired)
})

test('splitExceptionBlocks finds one block per exception', () => {
  const captured = `${WIDGETS_ERROR}\n\n══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞══\nThe following assertion was thrown during paint():\nBoxConstraints forces an infinite width\n`
  const blocks = splitExceptionBlocks(captured)
  assert.equal(blocks.length, 2)
  assert.match(blocks[1], /RENDERING LIBRARY/)

  const single = splitExceptionBlocks(UNHANDLED)
  assert.equal(single.length, 1)

  assert.deepEqual(splitExceptionBlocks(''), [])
})

test('fingerprints ignore volatile ids and are stable across machines', () => {
  const one = parseExceptionText(WIDGETS_ERROR)
  const other = parseExceptionText(WIDGETS_ERROR.replace('#96fa1', '#aa11b'))
  assert.equal(
    errorFingerprint({ message: one.message, exception: one.exception, frames: one.frames }),
    errorFingerprint({ message: other.message, exception: other.exception, frames: other.frames }),
  )
  const rehosted = parseExceptionText(WIDGETS_ERROR.replace(/C:\/work/g, 'D:\\repo'))
  assert.equal(
    errorFingerprint({ message: rehosted.message, exception: rehosted.exception, frames: rehosted.frames }),
    errorFingerprint({ message: one.message, exception: one.exception, frames: one.frames }),
    'machine-specific absolute paths in the header do not change the fingerprint',
  )
  assert.equal(normalizeMessage('  Bad   state:\n nope #96fa1 '), 'Bad state: nope #id')
})

test('ingest dedupes by message + top frames and tracks count, firstAt, lastAt', () => {
  const store = createErrorStore({ capacity: 10 })
  const first = store.ingest({ text: WIDGETS_ERROR, kind: 'flutter', at: 1000, runId: 'run-1' })
  const second = store.ingest({ text: WIDGETS_ERROR, kind: 'flutter', at: 2500, runId: 'run-1' })
  assert.equal(first.fp, second.fp)
  assert.equal(second.count, 2)
  assert.equal(second.firstAt, 1000)
  assert.equal(second.lastAt, 2500)
  assert.equal(second.frames.length, 3)
  assert.equal(second.handled, false)
  assert.equal(second.runId, 'run-1')

  const result = store.query({})
  assert.equal(result.groups.length, 1)
  assert.equal(result.total, 1)
  assert.equal(result.nextCursor, 2, 'cursor counts ingests, so polls can resume')

  // Same message from a different code path → a different group.
  const other = store.ingest({
    message: 'Bad state: nope',
    stack: '#0      Other.build (package:probe/other.dart:9:1)',
    kind: 'dart',
    at: 3000,
  })
  assert.notEqual(other.fp, first.fp)
  assert.equal(store.query({}).groups.length, 2)
  store.dispose()
})

test('ingest accepts LogEntry-ish, Flutter.Error payloads and raw strings', () => {
  const store = createErrorStore({ capacity: 10 })

  // LogEntry-shaped input from stderr.
  const fromLog = store.ingest({ source: 'stderr', level: 'error', text: UNHANDLED, at: 5000, runId: 'run-2' })
  assert.equal(fromLog.kind, 'dart')
  assert.equal(fromLog.message, 'Bad state: boom')
  assert.equal(fromLog.firstAt, 5000)

  // vm service Flutter.Error payload (renderedErrorText + structured fields).
  const fromVm = store.ingest({
    kind: 'flutter',
    renderedErrorText: WIDGETS_ERROR,
    message: 'Bad state: nope',
    exception: 'The following StateError was thrown building ProbeApp:',
    stack: '#0      _ProbeAppState.build (package:probe/main.dart:20:5)',
    frames: [{ file: 'package:probe/main.dart', line: 20, column: 5, symbol: '_ProbeAppState.build' }],
    context: 'widgets library',
    runId: 'run-1',
    at: 6000,
  })
  assert.equal(fromVm.kind, 'flutter')
  assert.equal(fromVm.frames.length, 1)
  assert.equal(fromVm.message, 'Bad state: nope')

  // Raw string defaults to dart.
  const fromString = store.ingest('Unhandled exception:\nFormatException: bad input')
  assert.equal(fromString.kind, 'dart')
  assert.equal(fromString.message, 'FormatException: bad input')

  assert.equal(store.ingest({ text: 'flutter: all good' }), null)
  assert.equal(store.ingest(null), null)
  store.dispose()
})

test('ingestCapture parses a capture-flutter-errors blob with several blocks', () => {
  const store = createErrorStore({ capacity: 20 })
  const text = `${WIDGETS_ERROR}\n\n══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞══\nThe following assertion was thrown during paint():\nBoxConstraints forces an infinite width\n#0      RenderBox.performLayout (package:flutter/src/rendering/box.dart:2100:12)\n`
  const count = store.ingestCapture(text)
  assert.equal(count, 2)
  const groups = store.query({}).groups
  assert.equal(groups.length, 2)
  assert.equal(groups.every((group) => group.kind === 'flutter'), true)
  store.dispose()
})

test('query filters by kind, pattern, runId, since, limit and order', () => {
  const store = createErrorStore({ capacity: 20 })
  store.ingest({ text: WIDGETS_ERROR, kind: 'flutter', at: 1000, runId: 'run-a' })
  store.ingest({ text: UNHANDLED, kind: 'dart', at: 2000, runId: 'run-b' })
  store.ingest({ message: 'TEST FAILED: expected 1, got 2', kind: 'test', at: 3000, runId: 'run-a' })
  store.ingest({ message: 'Analyzer error: undefined_identifier', kind: 'analyze', at: 4000, runId: 'run-a' })

  assert.equal(store.query({}).groups.length, 4)
  assert.deepEqual(store.query({ kind: 'flutter' }).groups.map((group) => group.message), ['Bad state: nope'])
  assert.deepEqual(store.query({ kind: 'dart' }).groups.map((group) => group.message), ['Bad state: boom'])
  assert.equal(store.query({ runId: 'run-a' }).groups.length, 3)
  assert.deepEqual(store.query({ pattern: 'undefined_identifier' }).groups.map((group) => group.kind), ['analyze'])
  assert.deepEqual(store.query({ pattern: 'frame.*:5000' }).groups.map((group) => group.kind), ['flutter'], 'pattern also matches the stack')

  // Newest first by default, oldest first with order: 'asc'.
  assert.deepEqual(store.query({}).groups.map((group) => group.kind), ['analyze', 'test', 'dart', 'flutter'])
  assert.deepEqual(store.query({ order: 'asc' }).groups.map((group) => group.kind), ['flutter', 'dart', 'test', 'analyze'])
  assert.equal(store.query({ limit: 2 }).groups.length, 2)

  // Cursor semantics: groups whose last ingest is newer than `since`.
  const cursor = store.query({}).nextCursor
  assert.equal(cursor, 4)
  assert.equal(store.query({ since: cursor }).groups.length, 0)
  assert.equal(store.query({ since: cursor - 1 }).groups.length, 1)

  const counts = store.counts()
  assert.equal(counts.total, 4)
  assert.equal(counts.byKind.flutter, 1)
  assert.equal(counts.byKind.dart, 1)
  const fp = store.query({ kind: 'flutter' }).groups[0].fp
  assert.equal(store.get(fp).message, 'Bad state: nope')

  store.clear()
  assert.equal(store.query({}).groups.length, 0)
  assert.equal(store.query({}).nextCursor, cursor, 'the cursor stays monotonic after clear')
  store.dispose()
})

test('capacity bounds the number of groups, evicting the least recently seen', () => {
  const store = createErrorStore({ capacity: 2 })
  store.ingest({ message: 'first', at: 1000 })
  store.ingest({ message: 'second', at: 2000 })
  const refreshedFirst = store.ingest({ message: 'first', at: 3000 })
  assert.equal(refreshedFirst.count, 2)
  // Adding a third group must drop the least recently seen one ("second", lastAt 2000).
  store.ingest({ message: 'third', at: 4000 })
  assert.equal(store.size(), 2)
  const messages = store.query({}).groups.map((group) => group.message)
  assert.deepEqual(messages, ['third', 'first'])
  assert.equal(store.capacity, 2)
  store.dispose()
})

test('bus wiring ingests vm:flutter-error and error-level logs without double counting', () => {
  const bus = createBus()
  const store = createErrorStore({ bus, capacity: 20 })

  bus.emit('vm:flutter-error', {
    kind: 'flutter',
    renderedErrorText: WIDGETS_ERROR,
    message: 'Bad state: nope',
    runId: 'run-1',
  })
  assert.equal(store.query({}).groups.length, 1)
  assert.equal(store.query({}).groups[0].lastSeq, 1)

  // A `log` event from stderr with an unhandled exception is ingested.
  bus.emit('log', { source: 'stderr', level: 'error', text: UNHANDLED, at: 5000 })
  assert.equal(store.query({}).groups.length, 2)
  assert.equal(store.query({ kind: 'dart' }).groups[0].message, 'Bad state: boom')

  // `vm`-sourced log entries are skipped: the structured event already covers them.
  bus.emit('log', { source: 'vm', level: 'error', text: 'Flutter.Error: Bad state: nope', runId: 'run-1' })
  assert.equal(store.query({}).groups.length, 2)
  assert.equal(store.query({ kind: 'flutter' }).groups[0].count, 1)

  // Non-error logs are ignored even when noisy.
  bus.emit('log', { source: 'stdout', level: 'info', text: 'flutter: nothing to see' })
  assert.equal(store.query({}).groups.length, 2)

  // An error-level log containing a capture header is ingested even at `warn`.
  bus.emit('log', { source: 'flutter', level: 'warn', text: WIDGETS_ERROR, at: 6000 })
  assert.equal(store.query({ kind: 'flutter' }).groups[0].count, 2)

  store.dispose()
  bus.emit('vm:flutter-error', { message: 'after dispose', kind: 'dart' })
  assert.equal(store.query({}).groups.length, 0, 'dispose unsubscribed from the bus')
})