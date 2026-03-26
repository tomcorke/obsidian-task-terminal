import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ChildProcess } from "child_process";
import type { TerminalSession, ClaudeState } from "./types";
import type { StoredSession } from "./SessionStore";
import { StringDecoder } from "string_decoder";

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
  claudeSessionId: string | null = null;
  onLabelChange?: () => void;
  onProcessExit?: (code: number | null, signal: string | null) => void;
  onStateChange?: (state: ClaudeState) => void;
  private fitAddon: FitAddon;
  private resizeObserver: ResizeObserver;
  private _documentListeners: { event: string; handler: EventListener }[] = [];
  private cwd: string = "";

  // Claude state detection
  private _claudeState: ClaudeState = "inactive";
  private _lastOutputTime = 0;
  private _recentCleanLines: string[] = [];
  private _stateTimer: ReturnType<typeof setInterval> | null = null;
  private _isClaudeSession = false;
  /** Suppress "active" detection until this timestamp (ms). Used after reload
   *  to prevent stale xterm buffer content from triggering false active state. */
  private _suppressActiveUntil = 0;

  constructor(
    private parentEl: HTMLElement,
    private shell: string,
    cwd: string,
    label: string,
    private taskPath: string | null,
    preCommand?: string,
    private commandArgs?: string[],
    claudeSessionId?: string | null
  ) {
    this.claudeSessionId = claudeSessionId || null;
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
      macOptionIsMeta: true,
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

    // Scroll-to-bottom button
    TerminalTab.attachScrollButton(containerEl, terminal);

    // Prevent Obsidian from intercepting keyboard events when terminal is focused.
    //
    // Two layers:
    // 1. Bubble-phase stopPropagation on container - catches most events after
    //    xterm processes them, prevents Obsidian bubble-phase handlers.
    // 2. Capture-phase listener on document for specific modifier combos that
    //    Obsidian intercepts in its own capture-phase handlers (Shift+Enter,
    //    Alt/Option+Arrow, etc). These need stopping before Obsidian sees them,
    //    but we only block them when the terminal's textarea is focused.
    containerEl.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
    }, false);
    containerEl.addEventListener("keyup", (e: KeyboardEvent) => {
      e.stopPropagation();
    }, false);

    // Capture-phase interception for modifier combos Obsidian steals.
    // We can't just stopPropagation (that prevents xterm from seeing the event too).
    // Instead, synthesize the terminal escape sequence directly to PTY stdin,
    // then kill the event entirely so neither xterm nor Obsidian processes it.
    const textareaEl = containerEl.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    const captureHandler = TerminalTab.makeCaptureHandler(textareaEl, () => this.session);
    document.addEventListener("keydown", captureHandler, true);
    this._documentListeners = [{ event: "keydown", handler: captureHandler as EventListener }];

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
        this.startStateTracking();
        terminal.scrollToBottom();
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

    // Resize observer - skip fit when hidden to avoid zero-dimension issues
    this.resizeObserver = new ResizeObserver(() => {
      if (containerEl.hasClass("hidden")) return;
      requestAnimationFrame(() => {
        if (containerEl.hasClass("hidden")) return;
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

    // Detect Claude session rename in output stream.
    // Data may arrive split across chunks, so buffer partial lines.
    // Match only the actual CLI output line: "└ Session renamed to: <name>"
    // Anchored to start-of-line so it won't match prose containing the phrase
    const renamePattern = /^\s*[^\w]*Session renamed to:\s*(.+?)\s*$/;
    // Strip ANSI escape sequences comprehensively, replacing cursor-forward
    // (CSI nC) with equivalent spaces so TUI-rendered text preserves word gaps.
    const stripAnsi = (s: string) =>
      s
        // First pass: replace CSI cursor-forward (\x1b[nC) with n spaces
        .replace(/\x1b\[(\d+)C/g, (_m, n) => " ".repeat(parseInt(n, 10)))
        // Second pass: strip all remaining ANSI/control sequences
        // - CSI sequences: \x1b[ ... letter (SGR, cursor movement, erase, etc.)
        // - OSC sequences: \x1b] ... BEL(\x07) or ST(\x1b\\)
        // - SS2/SS3: \x1bN, \x1bO
        // - Other two-char escapes: \x1b followed by single char
        // - C0 controls that aren't whitespace
        .replace(/\x1b\[[0-9;?]*[a-zA-Z@`]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^\[(\]].?|\x1b[\(\)][A-Z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, "");

    // Use StringDecoder to handle multi-byte UTF-8 characters (like └)
    // split across data chunk boundaries
    const decoder = new StringDecoder("utf8");
    let lineBuffer = "";
    const checkRename = (data: Buffer) => {
      lineBuffer += decoder.write(data);
      // Split on any line ending style: \r\n, \n, or bare \r
      const lines = lineBuffer.split(/\r\n|\n|\r/);
      // Keep the last (possibly incomplete) chunk
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        const clean = stripAnsi(line);
        const match = clean.match(renamePattern);
        if (match) {
          const newLabel = match[1].trim();
          console.log("[task-terminal] Rename detected:", newLabel);
          this.session.label = newLabel;
          this.onLabelChange?.();
        }
      }
      // Also check the incomplete line buffer - handles the case where
      // rename output arrives without a trailing newline (e.g. Claude
      // goes straight back to waiting for input after /rename)
      if (lineBuffer) {
        const clean = stripAnsi(lineBuffer);
        const match = clean.match(renamePattern);
        if (match) {
          const newLabel = match[1].trim();
          console.log("[task-terminal] Rename detected (partial):", newLabel);
          this.session.label = newLabel;
          this.onLabelChange?.();
        }
      }
    };

    proc.stdout?.on("data", (data: Buffer) => {
      checkRename(data);
      this._trackOutput(data);
      terminal.write(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      checkRename(data);
      this._trackOutput(data);
      terminal.write(data);
    });

    proc.on("error", (err) => {
      console.error("[task-terminal] Process error:", err);
      terminal.write(`\r\n[Process error: ${err.message}]\r\n`);
    });

    proc.on("exit", (code, signal) => {
      terminal.write(`\r\n[Process exited (code: ${code}, signal: ${signal})]\r\n`);
      this.onProcessExit?.(code, signal);
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

  get isVisible(): boolean {
    return !this.session.containerEl.hasClass("hidden");
  }

  show(): void {
    this.session.containerEl.removeClass("hidden");
    // Double-rAF: first frame makes the element visible and triggers layout,
    // second frame has correct dimensions for fitAddon to measure.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.fitAddon.fit();
        this.session.terminal.scrollToBottom();
        this.session.terminal.focus();
      });
    });
  }

  hide(): void {
    this.session.containerEl.addClass("hidden");
  }

  refit(): void {
    if (this.session.containerEl.hasClass("hidden")) return;
    requestAnimationFrame(() => {
      try { this.fitAddon.fit(); } catch { /* ignore */ }
    });
  }

  /**
   * Extract live state for reload persistence. Does NOT dispose anything.
   * The returned StoredSession holds references to live objects (Terminal, process, DOM).
   */
  stash(): StoredSession {
    // Stop state timer during stash - will be restarted by fromStored
    if (this._stateTimer) {
      clearInterval(this._stateTimer);
      this._stateTimer = null;
    }
    return {
      id: this.session.id,
      taskPath: this.session.taskPath,
      label: this.session.label,
      claudeSessionId: this.claudeSessionId,
      terminal: this.session.terminal,
      fitAddon: this.fitAddon,
      containerEl: this.session.containerEl,
      process: this.session.process,
      documentListeners: [...this._documentListeners],
      resizeObserver: this.resizeObserver,
    };
  }

  /**
   * Create a TerminalTab wrapping an existing stored session (after reload).
   * Re-attaches DOM, re-registers keyboard listeners, but does NOT re-spawn a process.
   */
  static fromStored(stored: StoredSession, parentEl: HTMLElement): TerminalTab {
    injectXtermCss();

    const tab = Object.create(TerminalTab.prototype) as TerminalTab;
    tab.fitAddon = stored.fitAddon;
    tab._documentListeners = [];

    // Re-attach container DOM to the new parent
    parentEl.appendChild(stored.containerEl);

    // Re-register keyboard interception on container (bubble-phase)
    stored.containerEl.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
    }, false);
    stored.containerEl.addEventListener("keyup", (e: KeyboardEvent) => {
      e.stopPropagation();
    }, false);

    // Re-register capture-phase keyboard interception
    const textareaEl = stored.containerEl.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    const captureHandler = TerminalTab.makeCaptureHandler(textareaEl, () => tab.session);
    document.addEventListener("keydown", captureHandler, true);
    tab._documentListeners = [{ event: "keydown", handler: captureHandler as EventListener }];

    // Click-to-focus
    stored.containerEl.addEventListener("click", () => {
      stored.terminal.focus();
    });

    // Scroll-to-bottom button
    TerminalTab.attachScrollButton(stored.containerEl, stored.terminal);

    // Re-attach resize observer
    stored.resizeObserver.disconnect();
    tab.resizeObserver = new ResizeObserver(() => {
      if (stored.containerEl.hasClass("hidden")) return;
      requestAnimationFrame(() => {
        if (stored.containerEl.hasClass("hidden")) return;
        try { tab.fitAddon.fit(); } catch { /* ignore */ }
      });
    });
    tab.resizeObserver.observe(stored.containerEl);

    tab.claudeSessionId = stored.claudeSessionId || null;
    tab.session = {
      id: stored.id,
      taskPath: stored.taskPath,
      label: stored.label,
      process: stored.process,
      terminal: stored.terminal,
      containerEl: stored.containerEl,
    };

    // Resume state tracking for Claude sessions.
    // Suppress "active" detection for 5s to prevent stale xterm buffer
    // content from causing a false active flash on all cards after reload.
    tab._suppressActiveUntil = Date.now() + 5000;
    tab.startStateTracking();

    return tab;
  }

  /** Add a scroll-to-bottom button overlay to a terminal container. */
  private static attachScrollButton(containerEl: HTMLElement, terminal: Terminal): void {
    // Remove any existing button (e.g. from a previous reload)
    containerEl.querySelector(".terminal-scroll-bottom")?.remove();

    const scrollBtn = document.createElement("button");
    scrollBtn.className = "terminal-scroll-bottom";
    scrollBtn.setAttribute("aria-label", "Scroll to bottom");
    scrollBtn.innerHTML = "&#x2193;";
    scrollBtn.style.display = "none";
    containerEl.appendChild(scrollBtn);

    const updateScrollBtn = () => {
      const buf = terminal.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      scrollBtn.style.display = atBottom ? "none" : "flex";
    };
    terminal.onScroll(updateScrollBtn);
    terminal.onWriteParsed(updateScrollBtn);
    scrollBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      terminal.scrollToBottom();
      terminal.focus();
    });
  }

  /**
   * Create a capture-phase keydown handler that synthesizes terminal escape
   * sequences for modifier combos that Obsidian would otherwise steal.
   * Writes directly to PTY stdin, then kills the event so neither xterm
   * nor Obsidian processes it.
   */
  private static makeCaptureHandler(
    textareaEl: HTMLTextAreaElement | null,
    getSession: () => TerminalSession,
  ): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent) => {
      if (!textareaEl || document.activeElement !== textareaEl) return;

      let seq: string | null = null;

      if (e.key === "Enter" && e.shiftKey) {
        // Shift+Enter: CSI u encoding so Claude CLI sees it as distinct from Enter
        seq = "\x1b[13;2u";
      } else if (e.altKey && e.key === "ArrowLeft") {
        seq = "\x1bb"; // ESC b - word backward
      } else if (e.altKey && e.key === "ArrowRight") {
        seq = "\x1bf"; // ESC f - word forward
      } else if (e.altKey && e.key === "Backspace") {
        seq = "\x1b\x7f"; // ESC DEL - delete word backward
      } else if (e.altKey && e.key === "d") {
        seq = "\x1bd"; // ESC d - delete word forward
      }

      if (seq) {
        const proc = getSession().process;
        if (proc?.stdin && !proc.stdin.destroyed) {
          proc.stdin.write(seq);
        }
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };
  }

  /** Current Claude state for this terminal. Only meaningful for Claude/Agent sessions. */
  get claudeState(): ClaudeState {
    return this._claudeState;
  }

  get isClaudeSession(): boolean {
    return this._isClaudeSession;
  }

  /** Start state tracking for Claude/Agent sessions. Call after label is known. */
  startStateTracking(): void {
    this._isClaudeSession = this.detectClaudeLabel();
    if (!this._isClaudeSession) return;

    // On fresh spawn, assume active. After reload, start as idle to avoid
    // false active flash from stale buffer content.
    this._claudeState = this._suppressActiveUntil > 0 ? "idle" : "active";
    this._lastOutputTime = Date.now();
    if (!this._recentCleanLines) this._recentCleanLines = [];

    // Check state every 2 seconds
    this._stateTimer = setInterval(() => this._checkState(), 2000);
  }

  private detectClaudeLabel(): boolean {
    return !!this.claudeSessionId;
  }

  /** Called on each chunk of output data to track activity. */
  private _trackOutput(data: Buffer | string): void {
    if (!this._isClaudeSession) return;

    // Buffer recent clean lines for pattern matching (keep last 30 lines)
    const stripAnsi = (s: string) =>
      s.replace(/\x1b\[(\d+)C/g, (_m, n) => " ".repeat(parseInt(n, 10)))
       .replace(/\x1b\[[0-9;?]*[a-zA-Z@`]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^\[(\]].?|\x1b[\(\)][A-Z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

    const text = typeof data === "string" ? data : data.toString("utf8");
    const lines = stripAnsi(text).split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);

    this._recentCleanLines.push(...lines);
    if (this._recentCleanLines.length > 30) {
      this._recentCleanLines = this._recentCleanLines.slice(-30);
    }

    // Don't use output timing for state - _checkState reads the terminal
    // buffer directly instead, which is immune to status line redraw noise.
  }

  /**
   * Read the visible terminal screen content for state detection.
   * Uses xterm.js buffer API to get the actual rendered lines, which is
   * far more reliable than trying to classify raw stdout chunks.
   */
  private _readTerminalScreen(): string[] {
    const buf = this.session.terminal.buffer.active;
    const lines: string[] = [];
    // Read all rows up to cursor position + a few extra, capturing content lines.
    // The cursor position (baseY + cursorY) marks where content ends; rows below
    // are empty padding. Reading from the bottom of buf.length would miss
    // everything when the terminal is taller than the content.
    const contentEnd = buf.baseY + buf.cursorY + 2;
    const start = Math.max(0, contentEnd - 30);
    for (let i = start; i < contentEnd; i++) {
      const line = buf.getLine(i);
      if (line) {
        const text = line.translateToString(true).trim();
        if (text.length > 0) lines.push(text);
      }
    }
    return lines;
  }

  private _checkState(): void {
    if (!this._isClaudeSession) return;

    // Read the terminal screen directly to determine Claude's state.
    // This avoids the fundamental problem of classifying raw stdout
    // (status line redraws produce continuous output even when idle).
    const screenLines = this._readTerminalScreen();

    // Check for waiting patterns first (highest priority).
    // Run even if screenLines is empty - _looksLikeWaiting also checks _recentCleanLines.
    // But suppress waiting if the tab is currently visible - the user can already see it
    // and interact directly.
    if (this._looksLikeWaiting(screenLines)) {
      this._setClaudeState(this.isVisible ? "idle" : "waiting");
      return;
    }

    // Need screen content for idle/active detection
    if (screenLines.length === 0) return;

    // Claude's status bar always shows "❯" even when actively working.
    // To distinguish idle from active, look for structural indicators in the
    // last few lines only (near the status bar). Checking the full screen would
    // false-positive on Claude's own response text containing these characters.
    //   ✻ <text>… - spinner line with ellipsis means work in progress
    //   ⎿  <text>… - tool output with ellipsis means tool still running
    // When finished, ✻ shows past tense without ellipsis (e.g. "Brewed for 50s").
    const tail = screenLines.slice(-6);
    const hasActiveIndicator = tail.some(line =>
      /^\s*\u2733.*\u2026/.test(line) ||    // ✻ ... … (spinner with ellipsis = in progress)
      /^\s*⎿\s+.*\u2026/.test(line)         // ⎿  ...… (tool output with ellipsis = running)
    );

    if (hasActiveIndicator) {
      // During post-reload grace period, treat "active" as "idle" to prevent
      // stale buffer content from triggering false active indicators.
      if (Date.now() < this._suppressActiveUntil) {
        this._setClaudeState("idle");
      } else {
        this._setClaudeState("active");
      }
    } else {
      // Real output clears the suppression early - if the screen no longer
      // shows active indicators, the buffer has genuinely updated.
      this._suppressActiveUntil = 0;
      this._setClaudeState("idle");
    }
  }

  /**
   * Check if Claude is waiting for user input by inspecting both the terminal
   * screen buffer and recent output lines. The screen buffer is the primary
   * source since it shows the current rendered state.
   */
  private _looksLikeWaiting(screenLines?: string[]): boolean {
    // Merge screen lines and recent output for comprehensive detection
    const sources = [
      ...(screenLines || []),
      ...(this._recentCleanLines || []).slice(-15),
    ];
    if (sources.length === 0) return false;

    // Check the last N lines from each source
    const tail = sources.slice(-20);

    for (let i = tail.length - 1; i >= Math.max(0, tail.length - 15); i--) {
      const line = tail[i].trim();

      // Interactive selection UI: "Enter to select", "↑/↓ to navigate"
      if (/Enter to select|to navigate/i.test(line)) return true;

      // Permission prompt patterns: "Allow", "allowOnce", "denyOnce"
      if (/\bAllow\b.*\?/i.test(line)) return true;
      if (/\ballowOnce\b|\bdenyOnce\b|\ballowAlways\b/i.test(line)) return true;

      // AskUserQuestion patterns: numbered options with ">" selector or "(N)"
      if (/^\s*[>❯]\s*\d+\.\s+\S/.test(line)) return true;
      if (/^\s*\(?\d+\)?\s+\S/.test(line) && i > 0) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (tail[j].trim().endsWith("?")) return true;
        }
      }

      // Generic question pattern: line ends with "?" and is near the bottom
      if (i >= tail.length - 5 && line.endsWith("?") && line.length > 10) return true;

      // "Yes" / "No" option pair
      if (/^\s*(Yes|No)\s*$/i.test(line)) return true;
    }

    return false;
  }

  /** Clear the waiting state (e.g. when the user activates this tab to respond). */
  clearWaiting(): void {
    if (this._claudeState === "waiting") {
      this._setClaudeState("idle");
    }
  }

  private _setClaudeState(state: ClaudeState): void {
    if (this._claudeState === state) return;
    this._claudeState = state;
    this.onStateChange?.(state);
  }

  dispose(): void {
    // Stop state tracking
    if (this._stateTimer) {
      clearInterval(this._stateTimer);
      this._stateTimer = null;
    }
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
