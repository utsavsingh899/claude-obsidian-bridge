import { describe, expect, test } from 'claude-code/testing'

import * as N from './note'

const base = N.newNote({
  sessionId: 'abc',
  project: 'demo',
  cwd: '/x/demo',
  title: 'fix the bug',
  date: '2026-10-15',
  time: '6:20 PM',
  settleSeconds: 5,
})

function withReply(zone: string): string {
  const heading = base.lastIndexOf(N.REPLY_HEADING)
  return `${base.slice(0, heading)}${N.REPLY_HEADING}\n${zone}`
}

describe('parseReply', () => {
  test('an empty reply area has no message', () => {
    expect(N.parseReply(base)?.message).toBe(undefined)
  })

  test('text without a send line is not taken', () => {
    expect(N.parseReply(withReply('please also add tests\n- [ ] Send\n'))?.message).toBe(undefined)
  })

  test('text with a half-typed send word is not taken', () => {
    expect(N.parseReply(withReply('please also add tests\n/sen'))?.message).toBe(undefined)
  })

  test('a ticked box sends the text above it', () => {
    const reply = N.parseReply(withReply('please also add tests\nand run them\n- [x] Send\n'))
    expect(reply?.message).toBe('please also add tests\nand run them')
    expect(reply?.keep).toBe('')
  })

  test('a /send line sends the text above it', () => {
    expect(N.parseReply(withReply('\nyes, commit it\n/send'))?.message).toBe('yes, commit it')
  })

  test('text below the ticked box stays for the next message', () => {
    const reply = N.parseReply(withReply('first\n- [X] Send\nsecond, not done yet'))
    expect(reply?.message).toBe('first')
    expect(reply?.keep).toBe('second, not done yet')
  })

  test('text only below the ticked box is the message', () => {
    const reply = N.parseReply(withReply('\n- [x] Send\nwritten under the box\n'))
    expect(reply?.message).toBe('written under the box')
    expect(reply?.keep).toBe('')
  })

  test('a heading inside a callout is not the reply heading', () => {
    const note = `${base}> ${N.REPLY_HEADING}\n> hello\n- [x] Send\n`
    const reply = N.parseReply(note)
    expect(reply?.zone.startsWith('\n- [ ] Send')).toBe(true)
  })
})

describe('splices', () => {
  test('a log block goes above the reply heading', () => {
    const block = N.callout('quote', '6:21 PM · You (Mac)', 'hello')
    const out = N.applySplices(base, [N.logSplice(base, [block])])
    expect(out.indexOf(block) < out.indexOf(N.REPLY_HEADING)).toBe(true)
    expect(out.indexOf(N.LOG_HEADING) < out.indexOf(block)).toBe(true)
    expect(out.endsWith(`${N.REPLY_HEADING}\n${N.EMPTY_ZONE}`)).toBe(true)
  })

  test('a log block adds a new reply area when the heading is gone', () => {
    const out = N.applySplices('# hi\n', [N.logSplice('# hi\n', [N.callout('note', 'x')])])
    expect(N.parseReply(out)?.zone).toBe(N.EMPTY_ZONE)
  })

  test('props change only their own lines', () => {
    const out = N.applySplices(base, N.propsSplices(base, { status: '🟡 waiting for you', updated: '6:30 PM' }))
    expect(out).toContain('status: "🟡 waiting for you"')
    expect(out).toContain('updated: "6:30 PM"')
    expect(out).toContain('started: "2026-10-15 6:20 PM"')
  })

  test('taking a message logs it, keeps the draft and resets the box', () => {
    const note = withReply('do the thing\n- [x] Send\nnext draft')
    const reply = N.parseReply(note)
    if (reply === undefined) throw new Error('no reply area')
    const block = N.callout('quote', '6:31 PM · You (phone)', reply.message ?? '')
    const out = N.applySplices(note, N.consumeSplices(note, reply, [block], { status: '🟢 working' }))
    expect(out).toContain('> do the thing')
    expect(out.endsWith(`${N.REPLY_HEADING}\nnext draft\n${N.SEND_BOX}\n`)).toBe(true)
    expect(N.parseReply(out)?.message).toBe(undefined)
  })
})

describe('helpers', () => {
  test('the hash is stable and changes with the text', () => {
    expect(N.hash('abc')).toBe(N.hash('abc'))
    expect(N.hash('abc') === N.hash('abd')).toBe(false)
  })

  test('base64 encodes UTF-8', () => {
    expect(N.base64('hi ✍️')).toBe('aGkg4pyN77iP')
  })

  test('the app script has no backslash and no line break', () => {
    const script = N.appScript({ path: 'a/b.md', hash: '1:2', splices: [{ at: 0, remove: 0, insert: 'x\ny `z` \\' }] })
    expect(/[\\\n]/.test(script)).toBe(false)
  })

  test('the clock uses the 12-hour format', () => {
    const ms = Date.UTC(2026, 9, 16, 1, 5)
    expect(N.clock(ms, N.parseOffset('-0700'))).toEqual({ date: '2026-10-15', time: '6:05 PM', fileTime: '6-05 PM' })
    expect(N.clock(Date.UTC(2026, 9, 15, 0, 0), 0).time).toBe('12:00 AM')
  })

  test('the slug is safe for a file name', () => {
    expect(N.slug('fix: the "login" bug / today?')).toBe('fix the login bug today')
  })

  test('a Bash step shows its description, not the command', () => {
    const line = N.toolLine({ tool: 'Bash', input: { command: 'npm test -- --ci', description: 'Run the tests' }, cwd: '/x', home: '/h', time: '6:21 PM', isError: false })
    expect(line).toBe('- 6:21 PM · 🖥️ Run the tests')
  })

  test('a Bash step with no description shows only the program name', () => {
    const line = N.toolLine({ tool: 'Bash', input: { command: 'git status --short' }, cwd: '', home: '', time: '6:21 PM', isError: true })
    expect(line).toBe('- 6:21 PM · 🖥️ Ran `git` ❌')
  })

  test('an Edit step shows the path and the line counts, not the diff', () => {
    const result = { structuredPatch: [{ lines: [' keep', '-old', '+new', '+more'] }] }
    const counts = N.lineCounts('Edit', {}, result)
    expect(counts).toEqual({ added: 2, removed: 1, isNew: false })
    const line = N.toolLine({ tool: 'Edit', input: { file_path: '/x/src/a.ts' }, cwd: '/x', home: '', time: '6:22 PM', counts, isError: false })
    expect(line).toBe('- 6:22 PM · ✏️ Edited `src/a.ts` (+2 −1)')
  })

  test('a Write of a new file counts all its lines as added', () => {
    expect(N.lineCounts('Write', {}, { type: 'create', content: 'one\ntwo\n', structuredPatch: [] })).toEqual({ added: 2, removed: 0, isNew: true })
  })

  test('a failed change has no line counts', () => {
    expect(N.lineCounts('Edit', {}, 'Error: file not found')).toBe(undefined)
  })

  test('the turn summary adds up the files', () => {
    const files = new Map([['a', { added: 3, removed: 1 }], ['b', { added: 2, removed: 0 }]])
    expect(N.fileSummary(files)).toBe('2 files changed · +5 −1 lines')
    expect(N.fileSummary(new Map())).toBe('No files changed.')
  })

  test('steps in a row make one list, and callouts get blank lines', () => {
    const units = ['- 6:21 PM · a', '- 6:21 PM · b', N.callout('note', '6:22 PM · Claude', 'done'), '- 6:23 PM · c']
    const out = N.applySplices(base, [N.logSplice(base, units)])
    expect(out).toContain('- 6:21 PM · a\n- 6:21 PM · b\n\n> [!note] 6:22 PM · Claude\n> done\n\n- 6:23 PM · c\n\n## ✍️')
    const more = N.applySplices(out, [N.logSplice(out, ['- 6:24 PM · d'])])
    expect(more).toContain('- 6:23 PM · c\n- 6:24 PM · d\n\n## ✍️')
  })

  test('the note path is the start time, then the session name', () => {
    expect(N.notePathFor('Claude Sessions', '2026-10-15 9-16 PM', 'Claude Obsidian mod: offline?')).toBe('Claude Sessions/2026-10-15 9-16 PM - Claude Obsidian mod offline.md')
    expect(N.notePathFor('F', '2026-10-15 9-16 PM', 'x', 2)).toBe('F/2026-10-15 9-16 PM - x (2).md')
  })

  test('the start time comes back from an old or a new file name', () => {
    expect(N.stampOf('Claude Sessions/2026-10-15 9-16 PM - demo - fix the bug.md')).toBe('2026-10-15 9-16 PM')
    expect(N.stampOf('F/2026-10-15 12-05 AM - Name.md')).toBe('2026-10-15 12-05 AM')
    expect(N.stampOf('F/Untitled.md')).toBe(undefined)
  })

  test('the newest sidebar name wins, with escaped quotes', () => {
    const out = '"customTitle":"Old name"\n"customTitle":"Fix the \\"login\\" bug"\n'
    expect(N.parseTitle(out)).toBe('Fix the "login" bug')
    expect(N.parseTitle('')).toBe(undefined)
  })

  test('the heading changes to the session name', () => {
    const splice = N.headingSplice(base, 'Claude Obsidian mod')
    const out = N.applySplices(base, splice ? [splice] : [])
    expect(out).toContain('---\n# Claude Obsidian mod\n')
    expect(out.includes('# fix the bug')).toBe(false)
  })

  test('the CLI gets a vault argument only when there is a name', () => {
    expect(N.vaultArgs('My Vault')).toEqual(['vault=My Vault'])
    expect(N.vaultArgs('')).toEqual([])
  })

  test('quiet tools make no line', () => {
    expect(N.toolLine({ tool: 'ToolSearch', input: {}, cwd: '', home: '', time: '6:24 PM', isError: false })).toBe(undefined)
  })
})
