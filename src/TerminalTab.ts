import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, type ChildProcess } from "child_process";
import type { TerminalSession } from "./types";

let sessionCounter = 0;

export class TerminalTab {
  session: TerminalSession;
  private fitAddon: FitAddon;
  private resizeObserver: ResizeObserver;

  constructor(
    private parentEl: HTMLElement,
    private shell: string,
    private cwd: string,
    label: string,
    private taskPath: string | null,
    preCommand?: string
  ) {
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

    // Fit after a frame to ensure container has dimensions
    requestAnimationFrame(() => {
      this.fitAddon.fit();
    });

    // Spawn process with PTY via macOS `script` command
    const cols = terminal.cols || 80;
    const rows = terminal.rows || 24;
    const proc = this.spawnPty(cols, rows);

    // Wire terminal <-> process
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

    proc.on("exit", () => {
      terminal.write("\r\n[Process exited]\r\n");
    });

    // Send pre-command after shell init
    if (preCommand) {
      setTimeout(() => {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.write(preCommand + "\n");
        }
      }, 500);
    }

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
      process: proc,
      terminal,
      containerEl,
    };
  }

  private spawnPty(cols: number, rows: number): ChildProcess {
    // Use macOS `script` to allocate a real PTY without native modules
    const proc = spawn("script", ["-q", "/dev/null", this.shell], {
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
      },
    });
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
