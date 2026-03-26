import type { TaskTerminalSettings } from "./types";

// Use dynamic require to get child_process at runtime in Electron
function getSpawn(): typeof import("child_process").spawn {
  const cp = window.require ? window.require("child_process") : require("child_process");
  return cp.spawn;
}

export class PromptBox {
  private boxEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private statusEl: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private isVisible = false;
  private isRunning = false;

  constructor(
    private containerEl: HTMLElement,
    private settings: TaskTerminalSettings
  ) {
    // Toggle button
    const toggleBtn = containerEl.createEl("button", {
      cls: "prompt-box-toggle",
      text: "+ New Task",
    });
    toggleBtn.addEventListener("click", () => this.toggle());

    // Collapsible prompt area
    this.boxEl = containerEl.createDiv({ cls: "prompt-box" });
    this.boxEl.style.display = "none";

    this.inputEl = this.boxEl.createEl("textarea", {
      cls: "prompt-box-input",
      attr: { placeholder: "Describe a task to create or paste a URL to ingest..." },
    });
    this.inputEl.rows = 3;

    // Handle Ctrl+Enter to send
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.send();
      }
    });

    const actions = this.boxEl.createDiv({ cls: "prompt-box-actions" });
    this.sendBtn = actions.createEl("button", {
      cls: "prompt-box-send",
      text: "Send to Claude",
    });
    this.sendBtn.addEventListener("click", () => this.send());

    this.statusEl = actions.createDiv({ cls: "prompt-box-status" });
    this.statusEl.style.display = "none";
  }

  private toggle(): void {
    this.isVisible = !this.isVisible;
    this.boxEl.style.display = this.isVisible ? "block" : "none";
    if (this.isVisible) {
      this.inputEl.focus();
    }
  }

  private async send(): Promise<void> {
    const prompt = this.inputEl.value.trim();
    if (!prompt || this.isRunning) return;

    this.isRunning = true;
    this.sendBtn.disabled = true;
    this.sendBtn.textContent = "Running...";
    this.statusEl.style.display = "flex";
    this.statusEl.textContent = "Creating task...";
    this.statusEl.className = "prompt-box-status running";

    try {
      await this.runClaude(prompt);
      this.statusEl.textContent = "Task created";
      this.statusEl.className = "prompt-box-status success";
      this.inputEl.value = "";
    } catch (err) {
      this.statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      this.statusEl.className = "prompt-box-status error";
    } finally {
      this.isRunning = false;
      this.sendBtn.disabled = false;
      this.sendBtn.textContent = "Send to Claude";

      // Auto-hide status after 5 seconds
      setTimeout(() => {
        this.statusEl.style.display = "none";
      }, 5000);
    }
  }

  private runClaude(prompt: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const spawnFn = getSpawn();
      const path = (window.require || require)("path") as typeof import("path");

      const pluginBase = (process.env.HOME || "") + "/working/claude-sandbox/plugins";
      const wrapperPath = path.join(
        process.env.HOME || "",
        "working", "claude-sandbox", "obsidian-task-terminal", "src", "pty-wrapper.py"
      );

      const args = [
        wrapperPath, "80", "24", "--",
        this.settings.claudeCommand,
        "--dangerously-skip-permissions",
        "--plugin-dir", pluginBase + "/tc-services",
        "--plugin-dir", pluginBase + "/tc-tools",
        "--plugin-dir", pluginBase + "/tc-tasks",
        "--plugin-dir", pluginBase + "/tc-core",
        "--print",
        `/tc-tasks:task-agent ${prompt}`,
      ];

      const proc = spawnFn("python3", args, {
        cwd: process.env.HOME || "/",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          TERM: "xterm-256color",
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
      });

      let stderr = "";
      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => reject(err));

      proc.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.slice(0, 200) || `Exit code ${code}`));
        }
      });
    });
  }
}
