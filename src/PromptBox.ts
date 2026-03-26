import type { TaskTerminalSettings, KanbanColumn } from "./types";

// Use dynamic require to get Node builtins at runtime in Electron
function getChildProcess(): typeof import("child_process") {
  return window.require ? window.require("child_process") : require("child_process");
}

function getFs(): typeof import("fs") {
  return window.require ? window.require("fs") : require("fs");
}

export interface TaskCreationRequest {
  prompt: string;
  column: KanbanColumn;
}

export class PromptBox {
  private boxEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private activeCheckbox: HTMLInputElement;
  private isVisible = false;

  /** Called when the user submits a new task. The view creates the file and calls back with the path. */
  onSubmit?: (request: TaskCreationRequest) => void;

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

    // Enter sends, Shift+Enter inserts newline
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    const actions = this.boxEl.createDiv({ cls: "prompt-box-actions" });

    const activeLabel = actions.createEl("label", { cls: "prompt-box-active-label" });
    this.activeCheckbox = activeLabel.createEl("input", {
      type: "checkbox",
      cls: "prompt-box-active-checkbox",
    });
    activeLabel.appendText("Active");

    this.sendBtn = actions.createEl("button", {
      cls: "prompt-box-send",
      text: "Create Task",
    });
    this.sendBtn.addEventListener("click", () => this.send());
  }

  private toggle(): void {
    this.isVisible = !this.isVisible;
    this.boxEl.style.display = this.isVisible ? "block" : "none";
    if (this.isVisible) {
      this.inputEl.focus();
    }
  }

  private send(): void {
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;

    const column: KanbanColumn = this.activeCheckbox.checked ? "active" : "todo";

    // Immediately clear and allow next input
    this.inputEl.value = "";
    this.inputEl.focus();

    this.onSubmit?.({ prompt, column });
  }

  /**
   * Spawn Claude in the background to enrich an existing task file.
   * Returns a promise that resolves when Claude exits.
   */
  runBackgroundEnrich(taskPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cp = getChildProcess();
      const fs = getFs();

      const pluginBase = (process.env.HOME || "") + "/working/claude-sandbox/plugins";
      const pluginDirs = ["tc-services", "tc-tools", "tc-tasks", "tc-core"];

      const missing = pluginDirs.filter(
        (d) => !fs.existsSync(pluginBase + "/" + d)
      );
      if (missing.length > 0) {
        reject(new Error(`Missing plugin dirs: ${missing.join(", ")}`));
        return;
      }

      const args: string[] = ["--dangerously-skip-permissions"];
      for (const d of pluginDirs) {
        args.push("--plugin-dir", pluginBase + "/" + d);
      }
      args.push(
        "--print",
        `/tc-tasks:task-agent --fast The task file at ${taskPath} was just created with minimal data. Review it, run duplicate check, goal alignment, and related task detection. Update the file in place.`
      );

      // Electron GUI apps get a minimal PATH - ensure common install locations are included
      const home = process.env.HOME || "";
      const extraPaths = [
        `${home}/.local/bin`,
        `${home}/.nvm/versions/node/current/bin`,
        "/usr/local/bin",
        "/opt/homebrew/bin",
      ];
      const basePath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
      const fullPath = [...extraPaths, ...basePath.split(":")].filter(Boolean);
      const path = [...new Set(fullPath)].join(":");

      let command = this.settings.claudeCommand;
      if (!command.startsWith("/")) {
        for (const dir of fullPath) {
          const candidate = `${dir}/${command}`;
          if (fs.existsSync(candidate)) {
            command = candidate;
            break;
          }
        }
      }

      console.log(`[task-terminal] Background enrich: ${taskPath}`);

      const proc = cp.spawn(command, args, {
        cwd: home || "/",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          TERM: "xterm-256color",
          PATH: path,
        },
      });

      proc.stdin?.end();

      let stderr = "";
      let settled = false;

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        if (!settled && !proc.killed) {
          settled = true;
          proc.kill("SIGTERM");
          reject(new Error("Background enrich timed out after 120s"));
        }
      }, 120_000);

      proc.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      proc.on("exit", (code) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;

        if (code === 0) {
          console.log(`[task-terminal] Background enrich completed: ${taskPath}`);
          resolve();
        } else {
          const errMsg = stderr.trim().slice(0, 500) || `Exit code ${code}`;
          console.error(`[task-terminal] Background enrich failed: ${errMsg}`);
          reject(new Error(errMsg));
        }
      });
    });
  }
}
