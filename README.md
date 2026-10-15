# obsidian-bridge

obsidian-bridge is a mod for Claude Code. It keeps one note in your Obsidian vault for each Claude session. You can read the session on your phone, and you can send replies to Claude from the note.

## What it does

- It makes one note for each Claude session. The default folder in the vault is `Claude Sessions`.
- The note shows your prompts and the messages from Claude.
- The note shows each tool step as one short line, for example `✏️ Edited src/app.ts (+2 −1)`. It does not show the code, the command output or the diff.
- At the end of each turn, the note shows how many files and lines the turn changed.
- The note name is the start date and time, then the session name. An example is `2026-10-15 6-20 PM - Fix the login bug.md`. The first name comes from your first prompt. When the desktop app gives the session a name in its sidebar, the mod changes the note name to that name.
- The note properties show the status of the session: working, waiting for you, question on the Mac, or ended.

## Reply from your phone

1. Open the session note in Obsidian on your phone.
2. Write your message under the **Reply to Claude** heading, above the **Send** box.
3. Tick the **Send** box. You can also write a line with only `/send`.
4. Do not change the reply area after that.

Claude takes the reply only when the reply area stays the same for the settle time. The default settle time is 5 seconds. Claude then gets your text as the next prompt. If Claude is busy, it starts your message after the current turn. Text below a ticked box stays in the reply area for your next message.

A reply from the phone turns on away mode. In away mode, Claude does not open question dialogs on the Mac. Claude writes the question and the options in its reply, and you answer in the note. A prompt that you type on the Mac turns off away mode.

## How it writes the note

The mod writes to the note through the Obsidian command line interface (CLI) with `obsidian eval`. It changes the note only when the note is still the same as the copy that it read. Thus your edits on the phone are safe. If the CLI does not answer, the mod writes the note file directly.

## Requirements

- macOS. The mod uses macOS paths to find Obsidian and its vaults.
- A Claude Code version that can load mods (plugins with function hooks). The tests pass with Claude Code 2.1.294.
- Obsidian 1.12.7 or later on the Mac.
- The Obsidian CLI must be on. In Obsidian, go to **Settings → General → Advanced** and turn on **Command line interface**.
- Obsidian Sync or a different sync service that copies the vault to your phone.
- The Mac must stay awake, and Obsidian must stay open on the Mac. Claude reads your replies from the vault on the Mac.

## Install

### Install from the marketplace

1. Start Claude Code in a terminal.
2. Type this command:

   ```
   /plugin install obsidian-bridge --marketplace utsavsingh899/claude-obsidian-bridge
   ```

3. Type `y` to accept.
4. Select a scope. The `user` scope installs the mod for all of your sessions.
5. Restart Claude Code.

You can also install the mod from a shell:

```bash
claude plugin install obsidian-bridge --marketplace utsavsingh899/claude-obsidian-bridge
```

### Install from a local folder

1. Clone this repository:

   ```bash
   git clone https://github.com/utsavsingh899/claude-obsidian-bridge.git ~/.claude/mods/obsidian-bridge
   ```

2. Add the absolute path of the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/.claude/mods/obsidian-bridge"
     }
   }
   ```

3. Restart Claude Code.

## The /obsidian command

| Command | What it does |
| --- | --- |
| `/obsidian` | Shows the status: the mirror, away mode, the note path, an `obsidian://` link, and how the mod writes the note. |
| `/obsidian on` | Turns on the note for this session. |
| `/obsidian off` | Writes the last entries, then turns off the note for this session. |
| `/obsidian away` | Turns on away mode. Claude asks its questions in its reply, not in a dialog. |
| `/obsidian back` | Turns off away mode. |

## Options

The options are the `userConfig` fields in `.claude-plugin/plugin.json`. To see the values, run this command in a shell:

```bash
claude plugin configure obsidian-bridge
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Make a note for each session. `/obsidian on` and `/obsidian off` change this for one session. |
| `vault` | empty | The name of the vault, as the Obsidian CLI knows it. When it is empty, the mod uses the name of the vault folder. |
| `vaultPath` | empty | The absolute path of the vault. When it is empty, the mod finds the vault in the Obsidian vault list. It selects the vault with the name in `vault`, then the open vault, then the first vault. |
| `folder` | `Claude Sessions` | The folder in the vault for the session notes. |
| `cli` | empty | The path of the Obsidian CLI. When it is empty, the mod tries the usual locations. |
| `pollSeconds` | `3` | How often Claude reads the note for a reply, in seconds. |
| `settleSeconds` | `5` | The time in seconds that the reply area must stay the same before Claude takes the reply. |
| `flushSeconds` | `15` | How often Claude writes the collected tool steps into the note, in seconds. |

## Limits

- A permission prompt still stops the session. You cannot answer a permission prompt from the note. Answer it on the Mac.
- You get no push alerts. Open the note to see new messages from Claude.
- The note does not show the steps of subagents.
- The mod works only on macOS.

## Privacy

The note holds the text of your session. This text includes your prompts, the messages from Claude, the paths of the files that Claude reads and changes, and the path of the project folder. The mod writes this text into your vault. Your sync service then copies the text to your other devices and, for most services, to its servers. Do not use the mod for a session with secrets or other data that must not leave the Mac. To stop the note for one session, use `/obsidian off`.

The mod reads the session transcript in `~/.claude/projects` only to find the session name. The mod itself sends no data to a server.

## Development

The note logic is in `hooks/note.ts`. The hooks are in `hooks/register.ts`.

To run the tests, use this command:

```bash
claude plugin test .
```

To check the manifests and the hooks, use this command:

```bash
claude plugin validate .
```

## License

MIT. See [LICENSE](LICENSE).
