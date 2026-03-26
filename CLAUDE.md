# obsidian-task-terminal

Obsidian plugin: kanban task board (left) with per-task tabbed xterm.js terminals (right).

## Development workflow

- **Build**: `npm run build` (production) or `npm run dev` (watch mode)
- **Deploy**: esbuild copies output to `~/working/obsidian/test-vault/Test/.obsidian/plugins/task-terminal/`
- **Reload plugin in Obsidian**: disable+enable, NOT Cmd+R. Use the CDP script (`node cdp.js`) for programmatic reload.

After every code change:
1. Run `npm run build`
2. Reload the plugin in Obsidian (via CDP or manually)

## Commit discipline

Commit each discrete change to git individually with a clear message. Do not batch unrelated changes into a single commit.

## Architecture

Source is in `src/`. Key files:
- `main.ts` - plugin entry, settings, view registration
- `TaskTerminalView.ts` - ItemView subclass, split layout, resize divider
- `KanbanBoard.ts` - four-column board with HTML5 drag-and-drop
- `TaskCard.ts` - card rendering
- `ContextMenu.ts` - right-click context menu for task cards
- `TerminalPanel.ts` - tab bar + terminal container management
- `TerminalTab.ts` - xterm.js terminal + Python PTY wrapper spawn
- `pty-wrapper.py` - Python PTY allocator (pty.fork/openpty), proxies I/O, handles resize
- `TaskParser.ts` - parse frontmatter via MetadataCache
- `TaskMover.ts` - state transitions (move file, update frontmatter/tags/activity log)
- `types.ts` - TypeScript interfaces

## Known constraints

- **PTY**: Electron sandbox blocks `script`. Python `pty.fork()` is the workaround (`pty-wrapper.py`).
- **xterm.js CSS**: `require.resolve` unavailable in bundled context. Full CSS is embedded inline at runtime.
- **Tilde expansion**: Obsidian uses `~` in paths. Always expand via `process.env.HOME` before passing to `spawn`.
- **Node builtins**: Must use `window.require` for `child_process`, `fs`, `path`, `os` in Electron context. These are externalized in esbuild config.
- **Resize protocol**: Terminal resize sends `ESC]777;resize;COLS;ROWS BEL` through stdin; Python wrapper intercepts it and calls `ioctl(TIOCSWINSZ)` + `SIGWINCH`.

## Task files

Tasks live in the Obsidian vault under `2 - Areas/Tasks/{priority,todo,active,archive}/`. Frontmatter schema is defined by the task-agent skill. State transitions update frontmatter, tags, file location, and append to the activity log.
