// The pure logic of the session note. This file does not use `$`, so the
// tests can run it directly.

export const LOG_HEADING = '## 📜 Log'
export const REPLY_HEADING = '## ✍️ Reply to Claude'
export const SEND_BOX = '- [ ] Send'
// The reply area after the heading line: one empty line to write on, then the box.
export const EMPTY_ZONE = `\n${SEND_BOX}\n`

// A ticked Send box, or a line with only "/send".
const SEND_LINE = /^\s*(?:[-*+]\s+\[[xX]\]\s+send\b.*|\/send)\s*$/i
// Lines of the template that are not part of a message.
const TEMPLATE_LINE = /^\s*(?:[-*+]\s+\[ \]\s+send\b.*|<!--.*-->)\s*$/i

export type Splice = { at: number; remove: number; insert: string }

export type Reply = {
  // The index where the reply area starts (after the heading line).
  zoneStart: number
  // The full reply area as it was read.
  zone: string
  // The text to send. Undefined when no send line is in the area.
  message?: string
  // The text that stays in the reply area after Claude takes the message.
  keep: string
}

// FNV-1a over UTF-16 code units. The Obsidian side uses the same function.
export function hash(text: string): string {
  let x = 2166136261
  for (let i = 0; i < text.length; i++) {
    x ^= text.charCodeAt(i)
    x = Math.imul(x, 16777619) >>> 0
  }
  return `${text.length}:${x}`
}

export function applySplices(text: string, splices: readonly Splice[]): string {
  let out = text
  for (const s of sortSplices(splices)) {
    out = out.slice(0, s.at) + s.insert + out.slice(s.at + s.remove)
  }
  return out
}

// The last splice in the text comes first, so each index stays correct.
export function sortSplices(splices: readonly Splice[]): Splice[] {
  return [...splices].sort((a, b) => b.at - a.at)
}

function findReplyHeading(note: string): { start: number; zoneStart: number } | undefined {
  let from = note.length
  while (from >= 0) {
    const i = note.lastIndexOf(REPLY_HEADING, from)
    if (i < 0) return undefined
    const end = note.indexOf('\n', i)
    const lineEnd = end < 0 ? note.length : end
    const isLineStart = i === 0 || note[i - 1] === '\n'
    if (isLineStart && note.slice(i, lineEnd).trim() === REPLY_HEADING) {
      return { start: i, zoneStart: end < 0 ? note.length : end + 1 }
    }
    from = i - 1
  }
  return undefined
}

function trimBlankLines(lines: readonly string[]): string {
  const kept = lines.filter(line => !TEMPLATE_LINE.test(line))
  while (kept.length > 0 && !kept[0]?.trim()) kept.shift()
  while (kept.length > 0 && !kept[kept.length - 1]?.trim()) kept.pop()
  return kept.join('\n')
}

// Reads the reply area. The message is the text above the first send line.
// When nothing is above it, the message is the text below it.
export function parseReply(note: string): Reply | undefined {
  const heading = findReplyHeading(note)
  if (heading === undefined) return undefined
  const zone = note.slice(heading.zoneStart)
  const lines = zone.split('\n')
  const send = lines.findIndex(line => SEND_LINE.test(line))
  if (send < 0) return { zoneStart: heading.zoneStart, zone, keep: zone }
  const above = trimBlankLines(lines.slice(0, send))
  const below = trimBlankLines(lines.slice(send + 1))
  return above
    ? { zoneStart: heading.zoneStart, zone, message: above, keep: below }
    : { zoneStart: heading.zoneStart, zone, message: below, keep: '' }
}

function isListLine(line: string): boolean {
  return /^\s*[-*+] /.test(line)
}

// Puts log units above the reply heading. Tool lines in a row stay one list.
// A blank line goes between all other units. When the heading is gone, it
// adds a new reply area at the end.
export function logSplice(note: string, units: readonly string[]): Splice {
  const parts = units.map(unit => unit.replace(/\n+$/, '')).filter(Boolean)
  const heading = findReplyHeading(note)
  const end = heading?.start ?? note.length
  const before = note.slice(0, end).replace(/\n+$/, '')
  let last = before.slice(before.lastIndexOf('\n') + 1)
  let text = ''
  for (const part of parts) {
    const gap = before.length === 0 && text === '' ? '' : isListLine(last) && isListLine(part) ? '\n' : '\n\n'
    text += gap + part
    last = part.slice(part.lastIndexOf('\n') + 1)
  }
  const tail = heading ? '\n\n' : `\n\n${REPLY_HEADING}\n${EMPTY_ZONE}`
  return { at: before.length, remove: end - before.length, insert: text + tail }
}

// Sets frontmatter values. It changes only the lines of these keys.
export function propsSplices(note: string, props: Readonly<Record<string, string>>): Splice[] {
  if (!note.startsWith('---\n')) return []
  const close = note.indexOf('\n---', 3)
  if (close < 0) return []
  const frontmatter = note.slice(0, close + 1)
  const out: Splice[] = []
  for (const [key, value] of Object.entries(props)) {
    const line = `${key}: ${JSON.stringify(value)}`
    const found = new RegExp(`^${key}:.*$`, 'm').exec(frontmatter)
    out.push(
      found
        ? { at: found.index, remove: found[0].length, insert: line }
        : { at: close + 1, remove: 0, insert: `${line}\n` },
    )
  }
  return out
}

// The splices that take a message: log it, clear the reply area, set the props.
export function consumeSplices(
  note: string,
  reply: Reply,
  units: readonly string[],
  props: Readonly<Record<string, string>>,
): Splice[] {
  const zone = reply.keep ? `${reply.keep}\n${SEND_BOX}\n` : EMPTY_ZONE
  return [
    ...propsSplices(note, props),
    ...(units.length > 0 ? [logSplice(note, units)] : []),
    { at: reply.zoneStart, remove: reply.zone.length, insert: zone },
  ]
}

// Escapes each "<" outside code. Obsidian reads text such as <name> as an
// HTML tag, and a tag with no end can hide the rest of the note.
export function escapeTags(markdown: string): string {
  let fence: string | undefined
  return markdown
    .split('\n')
    .map(line => {
      const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (fence !== undefined) {
        if (mark && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = undefined
        return line
      }
      if (mark) {
        fence = mark
        return line
      }
      // Leave inline code as it is.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;')))
        .join('')
    })
    .join('\n')
}

export function callout(kind: string, title: string, body = '', isFolded = false): string {
  const head = `> [!${kind}]${isFolded ? '-' : ''} ${escapeTags(title)}`
  const lines = body
    ? escapeTags(body.replace(/\r\n?/g, '\n')).split('\n').map(line => (line ? `> ${line}` : '>'))
    : []
  return `${[head, ...lines].join('\n')}\n\n`
}

export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n… (cut. The full text is in the Claude app.)` : text
}

function short(text: string, max = 100): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``
}

// Tools that add no useful line to the log.
const QUIET_TOOLS = new Set(['ToolSearch', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up', 'AskUserQuestion'])

export type LineCounts = { added: number; removed: number; isNew: boolean }

type Hunk = { lines?: unknown }

function countLines(text: string): number {
  return text ? text.replace(/\n$/, '').split('\n').length : 0
}

// How many lines a file change added and removed, from the tool result.
// Undefined when the tool changed no file or the call failed.
export function lineCounts(tool: string, input: Readonly<Record<string, unknown>>, result: unknown): LineCounts | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as Record<string, unknown>
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  if (tool === 'Write' && r.type === 'create') {
    return { added: countLines(str(r.content) || str(input.content)), removed: 0, isNew: true }
  }
  if ((tool === 'Edit' || tool === 'Write') && Array.isArray(r.structuredPatch)) {
    const lines = (r.structuredPatch as Hunk[]).flatMap(h => (Array.isArray(h.lines) ? (h.lines as unknown[]) : []))
    return {
      added: lines.filter(line => typeof line === 'string' && line.startsWith('+')).length,
      removed: lines.filter(line => typeof line === 'string' && line.startsWith('-')).length,
      isNew: false,
    }
  }
  if (tool === 'NotebookEdit') {
    return { added: countLines(str(r.new_source)), removed: countLines(str(r.old_source)), isNew: false }
  }
  return undefined
}

function changes(counts: { added: number; removed: number }): string {
  return `+${counts.added} −${counts.removed}`
}

// One short list line for a tool call: what happened, with no code, input or output.
export function toolLine(o: {
  tool: string
  input: Readonly<Record<string, unknown>>
  cwd: string
  home: string
  time: string
  counts?: LineCounts
  isError: boolean
}): string | undefined {
  if (QUIET_TOOLS.has(o.tool)) return undefined
  const text = (key: string): string => {
    const value = o.input[key]
    return typeof value === 'string' ? value : ''
  }
  const path = (key: string): string => {
    const value = text(key)
    if (o.cwd && value.startsWith(`${o.cwd}/`)) return code(value.slice(o.cwd.length + 1))
    return code(o.home && value.startsWith(`${o.home}/`) ? `~${value.slice(o.home.length)}` : value)
  }
  const counted = o.counts ? ` (${changes(o.counts)})` : ''
  const what = ((): string => {
    switch (o.tool) {
      case 'Bash':
        return text('description')
          ? `🖥️ ${short(text('description'))}`
          : `🖥️ Ran ${code(text('command').trim().split(/\s+/)[0] ?? 'a command')}`
      case 'Read':
        return `📖 Read ${path('file_path')}`
      case 'Edit':
        return `✏️ Edited ${path('file_path')}${counted}`
      case 'Write':
        return `📝 ${o.counts?.isNew ? 'Created' : 'Wrote'} ${path('file_path')}${counted}`
      case 'NotebookEdit':
        return `✏️ Edited ${path('notebook_path')}${counted}`
      case 'Grep':
        return '🔎 Searched the code'
      case 'Glob':
        return '🔎 Looked for files'
      case 'WebFetch':
        return `🌐 Opened ${short(text('url').replace(/^https?:\/\//, ''), 60)}`
      case 'WebSearch':
        return `🌐 Searched the web for ${code(short(text('query'), 60))}`
      case 'Agent':
      case 'Task':
        return `🤖 Started a subagent: ${short(text('description'), 80)}`
      case 'TodoWrite':
        return '🗒️ Updated the task list'
      case 'Skill':
        return `🧩 Used the ${code(text('skill'))} skill`
    }
    const mcp = /^mcp__(.+?)__(.+)$/.exec(o.tool)
    return mcp ? `🔌 ${short(mcp[1] ?? '', 30)} · ${mcp[2]}` : `🔧 ${o.tool}`
  })()
  return `- ${o.time} · ${escapeTags(what)}${o.isError ? ' ❌' : ''}`
}

// The files that one turn changed, in one line.
export function fileSummary(files: ReadonlyMap<string, { added: number; removed: number }>): string {
  if (files.size === 0) return 'No files changed.'
  let added = 0
  let removed = 0
  for (const counts of files.values()) {
    added += counts.added
    removed += counts.removed
  }
  return `${files.size} ${files.size === 1 ? 'file' : 'files'} changed · ${changes({ added, removed })} lines`
}

type Question = { question?: unknown; options?: unknown }
type Option = { label?: unknown; description?: unknown }

export function questionsText(input: Readonly<Record<string, unknown>>): string {
  const questions = Array.isArray(input.questions) ? (input.questions as Question[]) : []
  return questions
    .map(q => {
      const options = Array.isArray(q.options) ? (q.options as Option[]) : []
      const rows = options.map(o => `- ${String(o.label ?? '')}${o.description ? ` — ${String(o.description)}` : ''}`)
      return [`**${String(q.question ?? '')}**`, ...rows].join('\n')
    })
    .join('\n\n')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Local date and 12-hour time. `offsetMinutes` is the zone offset from `date +%z`.
export function clock(ms: number, offsetMinutes: number): { date: string; time: string; fileTime: string } {
  const d = new Date(ms + offsetMinutes * 60_000)
  const h24 = d.getUTCHours()
  const h = h24 % 12 || 12
  const m = pad(d.getUTCMinutes())
  const ampm = h24 < 12 ? 'AM' : 'PM'
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${h}:${m} ${ampm}`,
    fileTime: `${h}-${m} ${ampm}`,
  }
}

export function parseOffset(text: string): number {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(text.trim())
  if (!m) return 0
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// A safe file-name part from free text.
export function slug(text: string, maxLength = 48, maxWords = 8): string {
  const words = text
    .replace(/[\\/:*?"<>|#^[\]{}`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .split(' ')
    .slice(0, maxWords)
    .join(' ')
  return words.slice(0, maxLength).trim() || 'session'
}

// The note path: the start date and time, then the session name.
export function notePathFor(folder: string, stamp: string, name: string, copy = 1): string {
  return `${folder}/${stamp} - ${slug(name, 80, 20)}${copy > 1 ? ` (${copy})` : ''}.md`
}

// The start date and time at the front of a note file name.
export function stampOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? ''
  return /^(\d{4}-\d\d-\d\d \d{1,2}-\d\d [AP]M)/.exec(name)?.[1]
}

// The newest session name in the `grep -o` output of the transcript's
// "customTitle" fields. The desktop app writes this name in its sidebar.
export function parseTitle(grepOutput: string): string | undefined {
  const last = grepOutput.trim().split('\n').pop() ?? ''
  if (!last.startsWith('"customTitle":')) return undefined
  try {
    const value = (JSON.parse(`{${last}}`) as { customTitle?: unknown }).customTitle
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

// Replaces the first H1 line after the frontmatter.
export function headingSplice(note: string, text: string): Splice | undefined {
  const close = note.startsWith('---\n') ? note.indexOf('\n---', 3) + 4 : 0
  const found = /^# .*$/m.exec(note.slice(close))
  if (!found) return undefined
  return { at: close + found.index, remove: found[0].length, insert: `# ${text}` }
}

export function newNote(o: {
  sessionId: string
  project: string
  cwd: string
  title: string
  date: string
  time: string
  settleSeconds: number
}): string {
  return [
    '---',
    `claude_session: ${JSON.stringify(o.sessionId)}`,
    `project: ${JSON.stringify(o.project)}`,
    `cwd: ${JSON.stringify(o.cwd)}`,
    `status: ${JSON.stringify('🟢 working')}`,
    `started: ${JSON.stringify(`${o.date} ${o.time}`)}`,
    `updated: ${JSON.stringify(o.time)}`,
    'tags:',
    '  - claude-session',
    '---',
    `# ${o.title}`,
    '',
    callout(
      'info',
      'How to reply from your phone',
      [
        `1. Write your message under **Reply to Claude**, above the **Send** box.`,
        '2. Tick the **Send** box. You can also write a line with only `/send`.',
        `3. Claude takes the message when the reply area stays the same for ${o.settleSeconds} seconds.`,
        '4. Text below a ticked box stays in the area for your next message.',
      ].join('\n'),
      true,
    ).trimEnd(),
    '',
    LOG_HEADING,
    '',
    REPLY_HEADING,
    EMPTY_ZONE,
  ].join('\n')
}

// The prompt as you typed it. The app wraps the text that it adds in tags with
// a hyphen, such as <system-reminder> and <side-sessions-event>. This removes
// those blocks. A prompt with only such blocks did not come from you.
export function cleanPrompt(text: string): string {
  return text
    .replace(/<([a-z][a-z0-9]*-[a-z0-9-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The `vault=` argument for the Obsidian CLI. No name: the CLI uses its active vault.
export function vaultArgs(name: string): string[] {
  return name ? [`vault=${name}`] : []
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(text: string): string {
  const b = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += i + 1 < b.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < b.length ? B64[n & 63] : '='
  }
  return out
}

// The JavaScript that runs in Obsidian through `obsidian eval`. It has no
// backslashes and no line breaks, because the CLI changes `\n` in values.
// It applies the splices only when the note still has the expected hash.
export function appScript(payload: unknown): string {
  return [
    '(async()=>{',
    `const P=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob("${base64(JSON.stringify(payload))}"),c=>c.charCodeAt(0))));`,
    'const H=s=>{let x=2166136261;for(let i=0;i<s.length;i++){x^=s.charCodeAt(i);x=Math.imul(x,16777619)>>>0}return s.length+":"+x};',
    'const f=app.vault.getAbstractFileByPath(P.path);',
    'if(P.rename!==undefined){if(!f)return "missing";if(app.vault.getAbstractFileByPath(P.rename))return "exists";',
    'await app.fileManager.renameFile(f,P.rename);return "ok"}',
    'if(P.create!==undefined){if(f)return "exists";',
    'const d=P.path.split("/").slice(0,-1).join("/");',
    'if(d&&!app.vault.getAbstractFileByPath(d))await app.vault.createFolder(d);',
    'await app.vault.create(P.path,P.create);return "created"}',
    'if(!f)return "missing";let r="conflict";',
    'await app.vault.process(f,c=>{if(H(c)!==P.hash)return c;let o=c;',
    'for(const s of P.splices)o=o.slice(0,s.at)+s.insert+o.slice(s.at+s.remove);r="ok";return o});',
    'return r})()',
  ].join('')
}
