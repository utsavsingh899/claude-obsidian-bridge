import type { Hook, PluginOptions, Register } from 'claude-code'

import * as N from './note'

type Engine = Parameters<Hook<'session.start'>>[0]

type Options = {
  isEnabled: boolean
  vault: string
  vaultPath: string
  folder: string
  cli: string
  pollMs: number
  settleMs: number
  flushMs: number
}

type Outcome = 'ok' | 'conflict' | 'missing' | 'created' | 'exists' | 'error'

const ME = 'obsidian-bridge'

const AWAY_DENY =
  'The user is away from the Mac and reads this session in an Obsidian note on the phone. ' +
  'The user cannot answer this dialog. Write your question and the options as plain text in your reply, ' +
  "then end your turn. The user's answer comes as the next prompt."

// The module state. A hot reload starts it again; the note path and the
// session modes are in `$.store`, so they stay.
// A log entry that waits for the next write. Tool calls wait up to the flush
// time; messages from you or Claude go out at the next tick.
type Entry = { text: string; isUrgent: boolean; at: number }

let items: Entry[] = []
let props: Record<string, string> = {}
let isBusy = false
let hasTurnText = false
// The files that the current turn changed, with the lines added and removed.
const turnFiles = new Map<string, { added: number; removed: number }>()
let firstPrompt: string | undefined
let offsetMinutes = 0
let home = ''
let vaultRoot = ''
// The vault name for the CLI: the `vault` option, or the name of the vault folder.
let vaultName = ''
let cliPath: string | undefined
let cliCheckedAt = 0
let settle: { zone: string; since: number } | undefined
let lock: Promise<unknown> = Promise.resolve()
let isTickQueued = false
let conflictStreak = 0
const shown = new Set<string>()
// The transcript file of each session. Its "customTitle" lines hold the name
// that the desktop app shows in its sidebar.
const transcripts = new Map<string, string>()
let lastTitleCheck = 0
let isTitleDue = true

function readOptions(options: PluginOptions): Options {
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    isEnabled: options.enabled !== false,
    vault: String(options.vault ?? ''),
    vaultPath: String(options.vaultPath ?? ''),
    folder: String(options.folder ?? 'Claude Sessions').replace(/^\/+|\/+$/g, ''),
    cli: String(options.cli ?? ''),
    pollMs: Math.max(1, num(options.pollSeconds, 3)) * 1000,
    settleMs: Math.max(0, num(options.settleSeconds, 5)) * 1000,
    flushMs: Math.max(1, num(options.flushSeconds, 15)) * 1000,
  }
}

// Runs one job at a time, so two writes to the note never overlap.
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = lock.then(job, job)
  lock = run.catch(() => undefined)
  return run
}

function now(): { ms: number; date: string; time: string; fileTime: string } {
  const ms = Date.now()
  return { ms, ...N.clock(ms, offsetMinutes) }
}

function showOnce($: Engine, text: string): void {
  if (shown.has(text)) return
  shown.add(text)
  $.ui.toast(`${ME}: ${text}`)
}

function pushBlock(block: string, isUrgent = true): void {
  items.push({ text: block, isUrgent, at: Date.now() })
  if (items.length > 500) items = items.slice(-500)
}

function units(entries: readonly Entry[]): string[] {
  return entries.map(entry => entry.text)
}

function isDue(opt: Options): boolean {
  const oldest = items[0]
  return (
    items.some(entry => entry.isUrgent) ||
    (oldest !== undefined && Date.now() - oldest.at >= opt.flushMs) ||
    Object.keys(props).length > 0
  )
}

async function isOn($: Engine, sessionId: string, opt: Options): Promise<boolean> {
  const mode = await $.store.get(`mode:${sessionId}`)
  return mode === 'on' ? true : mode === 'off' ? false : opt.isEnabled
}

async function setup($: Engine, opt: Options): Promise<void> {
  const [env, zone] = await Promise.all([
    $.process.run(['/usr/bin/printenv', 'HOME']),
    $.process.run(['/bin/date', '+%z']),
  ])
  home = env.stdout.trim()
  offsetMinutes = N.parseOffset(zone.stdout)
  vaultRoot = opt.vaultPath.replace(/^~(?=\/|$)/, home)
  if (!vaultRoot) vaultRoot = await findVault($, opt.vault)
  vaultName = opt.vault || vaultRoot.replace(/\/+$/, '').split('/').pop() || ''
  await findCli($, opt)
}

async function findVault($: Engine, name: string): Promise<string> {
  try {
    const raw = await $.fs.read(`${home}/Library/Application Support/obsidian/obsidian.json`)
    const vaults = Object.values((JSON.parse(raw) as { vaults?: Record<string, { path?: string; open?: boolean }> }).vaults ?? {})
    const pick =
      vaults.find(v => v.path?.split('/').pop() === name) ?? vaults.find(v => v.open) ?? vaults[0]
    return pick?.path ?? ''
  } catch {
    return ''
  }
}

async function findCli($: Engine, opt: Options): Promise<void> {
  cliCheckedAt = Date.now()
  const candidates = [
    opt.cli,
    '/usr/local/bin/obsidian',
    '/opt/homebrew/bin/obsidian',
    `${home}/.local/bin/obsidian`,
    '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (!(await $.fs.exists(candidate).catch(() => false))) continue
    try {
      const r = await $.process.run([candidate, ...N.vaultArgs(vaultName), 'version'], { timeoutMs: 15_000 })
      const said = `${r.stdout}\n${r.stderr}`
      if (r.exitCode === 0 && !/not enabled|error/i.test(said)) {
        cliPath = candidate
        return
      }
    } catch {
      // Try the next place.
    }
  }
  cliPath = undefined
  showOnce($, 'The Obsidian CLI does not answer. Claude writes the note file directly until it answers.')
}

function absolute(path: string): string {
  return `${vaultRoot}/${path}`
}

async function readNote($: Engine, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(absolute(path))
  } catch {
    return undefined
  }
}

async function runApp($: Engine, opt: Options, payload: unknown): Promise<string> {
  if (!cliPath) return 'no-cli'
  const r = await $.process.run([cliPath, ...N.vaultArgs(vaultName), 'eval', `code=${N.appScript(payload)}`], {
    timeoutMs: 20_000,
  })
  // `eval` prints the result as "=> value". An error prints "Error: ..." with exit code 0.
  const found = /^=> (ok|conflict|missing|created|exists)\s*$/m.exec(r.stdout)
  return found?.[1] ?? `unknown: ${(r.stdout + r.stderr).trim().slice(0, 200)}`
}

async function createNote($: Engine, opt: Options, path: string, content: string): Promise<Outcome> {
  if (cliPath) {
    const said = await runApp($, opt, { path, create: content })
    if (said === 'created' || said === 'exists') return said
    showOnce($, `Obsidian did not create the note (${said}). Claude writes the file directly.`)
  }
  if (await $.fs.exists(absolute(path))) return 'exists'
  await $.fs.write(absolute(path), content)
  return 'created'
}

// Applies the splices only when the note is still `before`.
async function applyToNote($: Engine, opt: Options, path: string, before: string, splices: N.Splice[]): Promise<Outcome> {
  const sorted = N.sortSplices(splices)
  const after = N.applySplices(before, sorted)
  if (cliPath) {
    const said = await runApp($, opt, { path, hash: N.hash(before), splices: sorted })
    conflictStreak = said === 'conflict' ? conflictStreak + 1 : 0
    // Obsidian keeps a copy that does not match the file. Write the file directly.
    if (said === 'conflict' && conflictStreak >= 5) {
      showOnce($, 'Obsidian and the note file do not match. Claude wrote the file directly.')
      conflictStreak = 0
      return applyToFile($, path, before, after)
    }
    if (said === 'ok' || said === 'conflict' || said === 'missing') return said
    // The CLI gave no clear answer. Look at the file to find out.
    const current = await readNote($, path)
    if (current === after) return 'ok'
    if (current === undefined) return 'missing'
    showOnce($, `Unclear answer from the Obsidian CLI: ${said}`)
    return current === before ? 'conflict' : 'error'
  }
  return applyToFile($, path, before, after)
}

async function applyToFile($: Engine, path: string, before: string, after: string): Promise<Outcome> {
  const current = await readNote($, path)
  if (current === undefined) return 'missing'
  if (current !== before) return 'conflict'
  await $.fs.write(absolute(path), after)
  return 'ok'
}

async function notePath($: Engine, sessionId: string): Promise<string | undefined> {
  const path = await $.store.get(`note:${sessionId}`)
  return typeof path === 'string' ? path : undefined
}

async function makeNote($: Engine, opt: Options, sessionId: string): Promise<string | undefined> {
  const t = now()
  const cwd = await $.session.cwd()
  const project = cwd.split('/').pop() || 'session'
  // The sidebar name comes after the first turn starts. Until then, use the first prompt.
  const sessionName = await sessionTitle($, sessionId).catch(() => undefined)
  const name = sessionName ?? N.slug(firstPrompt ?? 'session')
  const template = N.newNote({
    sessionId,
    project,
    cwd,
    title: name,
    date: t.date,
    time: t.time,
    settleSeconds: Math.round(opt.settleMs / 1000),
  })
  const content = N.applySplices(template, [
    ...(items.length > 0 ? [N.logSplice(template, units(items))] : []),
    ...N.propsSplices(template, { ...props, updated: t.time, ...(sessionName ? { session: sessionName } : {}) }),
  ])
  for (let copy = 1; copy <= 9; copy++) {
    const path = N.notePathFor(opt.folder, `${t.date} ${t.fileTime}`, name, copy)
    if (await $.fs.exists(absolute(path)).catch(() => false)) continue
    if ((await createNote($, opt, path, content)) !== 'created') continue
    await $.store.set(`note:${sessionId}`, path)
    if (sessionName) await $.store.set(`named:${sessionId}`, sessionName)
    items = []
    props = {}
    $.ui.toast(`Session note: ${path}`)
    return path
  }
  showOnce($, `Could not make a note in ${opt.folder}.`)
  return undefined
}

// The session name from the sidebar, or undefined when the session has none yet.
async function sessionTitle($: Engine, sessionId: string): Promise<string | undefined> {
  let transcript = transcripts.get(sessionId)
  if (transcript === undefined) {
    const found = await $.process.run(['/usr/bin/find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`])
    transcript = found.stdout.trim().split('\n')[0] ?? ''
    if (!transcript) return undefined
    transcripts.set(sessionId, transcript)
  }
  const r = await $.process.run(['/usr/bin/grep', '-oE', '"customTitle":"([^"\\\\]|\\\\.)*"', transcript])
  return N.parseTitle(r.stdout)
}

async function renameFile($: Engine, opt: Options, from: string, to: string): Promise<Outcome> {
  if (cliPath) {
    const said = await runApp($, opt, { path: from, rename: to })
    if (said === 'ok' || said === 'exists' || said === 'missing') return said
  }
  const r = await $.process.run(['/bin/mv', '-n', absolute(from), absolute(to)])
  return r.exitCode === 0 && (await $.fs.exists(absolute(to))) ? 'ok' : 'error'
}

// Renames the note to "<start date and time> - <session name>.md" when the
// session gets a name or you rename the session in the sidebar.
async function syncName($: Engine, opt: Options, sessionId: string): Promise<void> {
  const path = await notePath($, sessionId)
  if (path === undefined) return
  const title = await sessionTitle($, sessionId)
  if (title === undefined || title === (await $.store.get(`named:${sessionId}`))) return
  const stamp = N.stampOf(path) ?? `${now().date} ${now().fileTime}`
  let current = path
  for (let copy = 1; copy <= 9; copy++) {
    const target = N.notePathFor(opt.folder, stamp, title, copy)
    if (target === path) break
    if (await $.fs.exists(absolute(target)).catch(() => false)) continue
    if ((await renameFile($, opt, path, target)) !== 'ok') return
    current = target
    await $.store.set(`note:${sessionId}`, target)
    break
  }
  // Show the new name in the note heading and its properties too.
  const before = await readNote($, current)
  if (before === undefined) return
  const heading = N.headingSplice(before, title)
  const splices = [...N.propsSplices(before, { session: title }), ...(heading ? [heading] : [])]
  if ((await applyToNote($, opt, current, before, splices)) !== 'ok') return
  await $.store.set(`named:${sessionId}`, title)
}

async function writePending($: Engine, opt: Options, sessionId: string): Promise<void> {
  if (items.length === 0 && Object.keys(props).length === 0) return
  const path = await notePath($, sessionId)
  if (path === undefined) {
    await makeNote($, opt, sessionId)
    return
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readNote($, path)
    if (before === undefined) {
      // You deleted the note. Start a new one.
      await $.store.delete(`note:${sessionId}`)
      await makeNote($, opt, sessionId)
      return
    }
    const writing = items.length
    const values = { ...props, updated: now().time }
    const splices = [...N.propsSplices(before, values)]
    if (writing > 0) splices.push(N.logSplice(before, units(items.slice(0, writing))))
    const outcome = await applyToNote($, opt, path, before, splices)
    if (outcome === 'ok') {
      items = items.slice(writing)
      props = {}
      return
    }
    if (outcome !== 'conflict') return
    await $.clock.sleep(300)
  }
}

async function takeReply($: Engine, opt: Options, sessionId: string): Promise<void> {
  const path = await notePath($, sessionId)
  if (path === undefined) return
  const note = await readNote($, path)
  if (note === undefined) return
  const reply = N.parseReply(note)
  if (reply?.message === undefined) {
    settle = undefined
    return
  }
  const t = now()
  // Take the message only after the reply area stays the same for the settle time.
  if (settle?.zone !== reply.zone) {
    settle = { zone: reply.zone, since: t.ms }
    return
  }
  if (t.ms - settle.since < opt.settleMs) return
  const message = reply.message
  const youBlock = message
    ? N.callout('quote', `${t.time} · You (phone)`, message + (isBusy ? '\n\n_Claude starts this after the current turn._' : ''))
    : ''
  const status: Record<string, string> = message ? { status: '🟢 working', updated: t.time } : { updated: t.time }
  // Write the entries that wait, so the log stays in order.
  const outcome = await applyToNote($, opt, path, note, N.consumeSplices(note, reply, [...units(items), ...(youBlock ? [youBlock] : [])], status))
  if (outcome !== 'ok') return
  items = []
  settle = undefined
  if (!message) return
  await $.store.set(`away:${sessionId}`, true)
  void $.prompt.submit({ text: message, asUser: true }).catch(() => showOnce($, 'Could not send your reply to Claude.'))
}

async function tick($: Engine, opt: Options): Promise<void> {
  if (isTickQueued) return
  isTickQueued = true
  await serial(async () => {
    isTickQueued = false
    try {
      const sessionId = await $.session.id()
      if (!(await isOn($, sessionId, opt))) {
        items = []
        props = {}
        return
      }
      if (!cliPath && Date.now() - cliCheckedAt > 60_000) await findCli($, opt)
      if (isDue(opt)) await writePending($, opt, sessionId)
      if (isTitleDue || Date.now() - lastTitleCheck >= 30_000) {
        lastTitleCheck = Date.now()
        isTitleDue = false
        await syncName($, opt, sessionId)
      }
      await takeReply($, opt, sessionId)
    } catch (error) {
      showOnce($, `The note update failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

function statusText(path: string | undefined, isMirrored: boolean, isAway: boolean): string {
  const link = path && vaultName ? `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path)}` : ''
  return [
    `Mirror: ${isMirrored ? 'on' : 'off'}`,
    `Away mode: ${isAway ? 'on (Claude asks questions in its reply, not in a dialog)' : 'off'}`,
    `Note: ${path ?? '(Claude makes it with the next update)'}`,
    link ? `Open: ${link}` : '',
    `Writes through: ${cliPath ? `Obsidian CLI (${cliPath})` : `the file system (${vaultRoot || 'vault not found'})`}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export const register: Register = (on, options) => {
  const opt = readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'obsidian',
      description: 'Show or change the Obsidian session note',
      argumentHint: '[on|off|away|back]',
      immediate: true,
    })
    await setup($, opt).catch(error => showOnce($, `Setup failed: ${String(error)}`))
    $.clock.every(opt.pollMs, () => void tick($, opt))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin
    const isMine = origin.kind === 'plugin' && origin.name === ME
    const isPerson = origin.kind === 'composer' || origin.kind === 'sdk' || origin.kind === 'bridge' || origin.kind === 'unclassified'
    const typed = N.cleanPrompt(e.text)
    if (!isMine && isPerson && typed && !typed.startsWith('/')) {
      firstPrompt ??= typed
      await $.store.delete(`away:${await $.session.id()}`)
      pushBlock(N.callout('quote', `${now().time} · You (Mac)`, N.cut(typed, 4000)))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isBusy = true
    hasTurnText = false
    turnFiles.clear()
    props.status = '🟢 working'
    return next(e)
  })

  // Each text block of Claude's reply, exactly as the conversation keeps it.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    // No message: a hook refused the row, so the conversation does not keep it.
    const message = stored.message
    if (e.agentId === undefined && e.door === 'response' && message?.role === 'assistant') {
      const text = message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n\n')
      if (text.trim()) {
        hasTurnText = true
        pushBlock(N.callout('note', `${now().time} · Claude`, N.cut(text, 50_000)))
      }
    }
    return stored
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const t = now()
    if (tool === 'AskUserQuestion') {
      const asked = N.questionsText(input)
      if (await $.store.get(`away:${await $.session.id()}`)) {
        pushBlock(N.callout('question', `${t.time} · Claude has a question`, `${asked}\n\n_You are away, so Claude asks in its reply. Answer under Reply to Claude._`))
        return { deny: AWAY_DENY }
      }
      pushBlock(N.callout('question', `${t.time} · Claude asks on the Mac`, asked))
      props.status = '❓ question on the Mac'
    }
    const ran = await next(e)
    const isError = ran.isError === true || ran.deny !== undefined
    if (tool === 'mcp__ccd_turn__wrap_up') {
      // The recap that the app shows at the end of a turn is a message from Claude.
      const said = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
      const body = [said('recap'), said('ask') ? `**Question:** ${said('ask')}` : ''].filter(Boolean).join('\n\n')
      if (body) pushBlock(N.callout('abstract', `${t.time} · Claude · recap`, body))
      return ran
    }
    const counts = isError ? undefined : N.lineCounts(tool, input, (ran as { result?: unknown }).result)
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (counts && file) {
      const sum = turnFiles.get(file) ?? { added: 0, removed: 0 }
      turnFiles.set(file, { added: sum.added + counts.added, removed: sum.removed + counts.removed })
    }
    const line = N.toolLine({ tool, input, cwd: await $.session.cwd(), home, time: t.time, counts, isError })
    if (line) pushBlock(line, false)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isBusy = false
    const t = now()
    // When no reply text came through session.append, log the final answer here.
    if (!hasTurnText && e.answer.trim()) pushBlock(N.callout('note', `${t.time} · Claude`, N.cut(e.answer, 50_000)))
    const kind = e.reason === 'answer' ? 'success' : e.reason === 'aborted' ? 'warning' : 'failure'
    const label = e.reason === 'answer' ? 'Turn done' : e.reason === 'aborted' ? 'Turn stopped' : `Turn ended (${e.reason})`
    pushBlock(N.callout(kind, `${t.time} · ${label} · ${N.duration(e.durationMs)}`, N.fileSummary(turnFiles)))
    props.status = '🟡 waiting for you'
    isTitleDue = true
    // Write at once. A reload of the mod clears the entries that wait in memory.
    const sessionId = await $.session.id()
    if (await isOn($, sessionId, opt)) await serial(() => writePending($, opt, sessionId)).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    const t = now()
    const why = e.reason === 'clear' ? 'A /clear started a new conversation. The next prompt starts a new note.' : ''
    pushBlock(N.callout('info', `${t.time} · Session ended (${e.reason})`, why))
    props.status = '⚪ ended'
    await serial(() => writePending($, opt, e.sessionId)).catch(() => undefined)
    firstPrompt = undefined
    return next(e)
  })

  on('command.run', { command: 'obsidian' }, async ($, e) => {
    const sessionId = await $.session.id()
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on') {
      await $.store.set(`mode:${sessionId}`, 'on')
      pushBlock(N.callout('info', `${now().time} · Mirror on`))
    } else if (arg === 'off') {
      await serial(() => writePending($, opt, sessionId)).catch(() => undefined)
      await $.store.set(`mode:${sessionId}`, 'off')
    } else if (arg === 'away') {
      await $.store.set(`away:${sessionId}`, true)
      pushBlock(N.callout('info', `${now().time} · Away mode on`))
    } else if (arg === 'back') {
      await $.store.delete(`away:${sessionId}`)
    } else if (arg) {
      return { text: 'Use /obsidian, /obsidian on, /obsidian off, /obsidian away or /obsidian back.' }
    }
    const isMirrored = await isOn($, sessionId, opt)
    const isAway = Boolean(await $.store.get(`away:${sessionId}`))
    return { text: statusText(await notePath($, sessionId), isMirrored, isAway) }
  })
}
