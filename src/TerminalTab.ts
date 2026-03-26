import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ChildProcess } from "child_process";
import type { TerminalSession } from "./types";

// Use dynamic require to get child_process at runtime in Electron
function getSpawn(): typeof import("child_process").spawn {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cp = window.require ? window.require("child_process") : require("child_process");
  return cp.spawn;
}

declare global {
  interface Window {
    require?: NodeRequire;
  }
}

// Inject full xterm.js CSS once (embedded since require.resolve unavailable in Obsidian bundle)
let xtermCssInjected = false;
function injectXtermCss(): void {
  if (xtermCssInjected) return;
  xtermCssInjected = true;
  const style = document.createElement("style");
  style.id = "xterm-css";
  style.textContent = `
.xterm { cursor: text; position: relative; user-select: none; -ms-user-select: none; -webkit-user-select: none; }
.xterm.focus, .xterm:focus { outline: none; }
.xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.xterm .xterm-helper-textarea { padding: 0; border: 0; margin: 0; position: absolute; opacity: 0; left: -9999em; top: 0; width: 0; height: 0; z-index: -5; white-space: nowrap; overflow: hidden; resize: none; }
.xterm .composition-view { background: #000; color: #FFF; display: none; position: absolute; white-space: nowrap; z-index: 1; }
.xterm .composition-view.active { display: block; }
.xterm .xterm-viewport { background-color: #000; overflow-y: scroll; cursor: default; position: absolute; right: 0; left: 0; top: 0; bottom: 0; }
.xterm .xterm-screen { position: relative; }
.xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.xterm .xterm-scroll-area { visibility: hidden; }
.xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
.xterm.enable-mouse-events { cursor: default; }
.xterm.xterm-cursor-pointer, .xterm .xterm-cursor-pointer { cursor: pointer; }
.xterm.column-select.focus { cursor: crosshair; }
.xterm .xterm-accessibility:not(.debug), .xterm .xterm-message { position: absolute; left: 0; top: 0; bottom: 0; right: 0; z-index: 10; color: transparent; pointer-events: none; }
.xterm .xterm-accessibility-tree:not(.debug) *::selection { color: transparent; }
.xterm .xterm-accessibility-tree { user-select: text; white-space: pre; }
.xterm .live-region { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.xterm-dim { opacity: 1 !important; }
.xterm-underline-1 { text-decoration: underline; }
.xterm-underline-2 { text-decoration: double underline; }
.xterm-underline-3 { text-decoration: wavy underline; }
.xterm-underline-4 { text-decoration: dotted underline; }
.xterm-underline-5 { text-decoration: dashed underline; }
.xterm-overline { text-decoration: overline; }
.xterm-strikethrough { text-decoration: line-through; }
.xterm-screen .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute; }
.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer { z-index: 7; }
.xterm-decoration-overview-ruler { z-index: 8; position: absolute; top: 0; right: 0; pointer-events: none; }
.xterm-decoration-top { z-index: 2; position: relative; }
  `;
  document.head.appendChild(style);
}

let sessionCounter = 0;

export class TerminalTab {
  session: TerminalSession;
  private fitAddon: FitAddon;
  private resizeObserver: ResizeObserver;
  private _documentListeners: { event: string; handler: EventListener }[] = [];

  constructor(
    private parentEl: HTMLElement,
    private shell: string,
    cwd: string,
    label: string,
    private taskPath: string | null,
    preCommand?: string,
    private commandArgs?: string[]
  ) {
    // Expand ~ in cwd
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (cwd.startsWith("~/") || cwd === "~") {
      this.cwd = home + cwd.slice(1);
    } else if (!cwd.startsWith("/") && home) {
      this.cwd = home + "/" + cwd;
    } else {
      this.cwd = cwd;
    }

    injectXtermCss();

    const id = `term-${Date.now()}-${++sessionCounter}`;

    const containerEl = document.createElement("div");
    containerEl.addClass("terminal-instance");
    this.parentEl.appendChild(containerEl);

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    terminal.loadAddon(this.fitAddon);
    terminal.open(containerEl);

    // Prevent Obsidian from intercepting keyboard events when terminal is focused.
    // IMPORTANT: We use bubble-phase on the container, NOT capture-phase on
    // document. Capture-phase stopPropagation on document prevents the event
    // from descending to xterm's textarea, breaking backspace/arrow keys
    // (which xterm handles via keydown, not the input event).
    // Bubble-phase on the container lets xterm process the event first,
    // then stops it from reaching Obsidian's handlers above.
    containerEl.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
    }, false);
    containerEl.addEventListener("keyup", (e: KeyboardEvent) => {
      e.stopPropagation();
    }, false);

    // No document-level listeners needed
    this._documentListeners = [];

    // Ensure clicking the terminal area gives xterm focus
    containerEl.addEventListener("click", () => {
      terminal.focus();
    });

    // Fit first, then spawn with actual dimensions
    // commandArgs takes precedence over preCommand (which is a single string)
    const command = this.commandArgs || (preCommand ? [preCommand] : undefined);
    let proc: ChildProcess | null = null;

    const spawnWithFit = () => {
      try { this.fitAddon.fit(); } catch { /* ignore */ }
      if (proc) return; // Already spawned

      const cols = terminal.cols || 80;
      const rows = terminal.rows || 24;
      try {
        proc = this.spawnPty(cols, rows, command);
        console.log("[task-terminal] Spawned pid:", proc.pid, "cols:", cols, "rows:", rows);
        this.session.process = proc;
        this.wireProcess(proc, terminal);
      } catch (err) {
        console.error("[task-terminal] Failed to spawn:", err);
        terminal.write(`\r\n[Failed to spawn: ${err}]\r\n`);
      }
    };

    // Delay spawn to let CSS layout happen first
    setTimeout(spawnWithFit, 150);

    // Send resize control sequence to PTY wrapper on terminal resize
    terminal.onResize(({ cols, rows }) => {
      if (proc?.stdin && !proc.stdin.destroyed) {
        // Custom OSC sequence that pty-wrapper.py intercepts
        const resizeCmd = `\x1b]777;resize;${cols};${rows}\x07`;
        proc.stdin.write(resizeCmd);
      }
    });

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          this.fitAddon.fit();
        } catch {
          // ignore fit errors during cleanup
        }
      });
    });
    this.resizeObserver.observe(containerEl);

    this.session = {
      id,
      taskPath,
      label,
      process: null, // Set later by spawnWithFit
      terminal,
      containerEl,
    };
  }

  private wireProcess(proc: ChildProcess, terminal: Terminal): void {
    terminal.onData((data) => {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(data);
      }
    });

    proc.stdout?.on("data", (data: Buffer) => {
      terminal.write(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      terminal.write(data);
    });

    proc.on("error", (err) => {
      console.error("[task-terminal] Process error:", err);
      terminal.write(`\r\n[Process error: ${err.message}]\r\n`);
    });

    proc.on("exit", (code, signal) => {
      terminal.write(`\r\n[Process exited (code: ${code}, signal: ${signal})]\r\n`);
    });
  }

  private spawnPty(cols: number, rows: number, command?: string[]): ChildProcess {
    const spawnFn = getSpawn();

    // Resolve path to pty-wrapper.py bundled alongside the plugin
    const path = (window.require || require)("path") as typeof import("path");
    const pluginDir = path.dirname(
      (window.require || require).resolve
        ? ""
        : ""
    );

    // Find pty-wrapper.py relative to the plugin's main.js
    // The plugin manifest dir is where main.js lives
    let wrapperPath: string;
    try {
      // In Obsidian, we can find the plugin dir via the app
      const fs = (window.require || require)("fs") as typeof import("fs");
      const candidates = [
        path.join(this.cwd, "obsidian-task-terminal", "src", "pty-wrapper.py"),
        path.join(process.env.HOME || "", "working", "claude-sandbox", "obsidian-task-terminal", "src", "pty-wrapper.py"),
      ];
      wrapperPath = candidates.find(p => fs.existsSync(p)) || candidates[1];
    } catch {
      wrapperPath = path.join(process.env.HOME || "", "working", "claude-sandbox", "obsidian-task-terminal", "src", "pty-wrapper.py");
    }

    const cmd = command || [this.shell, "-i"];
    const args = [wrapperPath, String(cols), String(rows), "--", ...cmd];

    console.log("[task-terminal] Spawning via pty-wrapper:", args.join(" "));
    console.log("[task-terminal] cwd:", this.cwd);

    const proc = spawnFn("python3", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });
    console.log("[task-terminal] spawn pid:", proc.pid);
    return proc;
  }

  show(): void {
    this.session.containerEl.removeClass("hidden");
    requestAnimationFrame(() => {
      this.fitAddon.fit();
      this.session.terminal.focus();
    });
  }

  hide(): void {
    this.session.containerEl.addClass("hidden");
  }

  dispose(): void {
    // Remove document-level keyboard listeners
    for (const { event, handler } of this._documentListeners) {
      document.removeEventListener(event, handler, true);
    }
    this._documentListeners = [];
    this.resizeObserver.disconnect();
    if (this.session.process && !this.session.process.killed) {
      this.session.process.kill("SIGTERM");
      // Force kill after 1s if not exited
      setTimeout(() => {
        if (this.session.process && !this.session.process.killed) {
          this.session.process.kill("SIGKILL");
        }
      }, 1000);
    }
    this.session.terminal.dispose();
    this.session.containerEl.remove();
  }
}
