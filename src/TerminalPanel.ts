import type { TaskFile, TaskTerminalSettings } from "./types";
import { TerminalTab } from "./TerminalTab";
import { SessionStore } from "./SessionStore";

/**
 * Resolve a command name to an absolute path. Electron's process.env.PATH
 * may not include shell-profile dirs like ~/.local/bin, so commands like
 * `claude` fail with execvp ENOENT when spawned via the PTY wrapper.
 */
function resolveCommand(cmd: string): string {
  if (cmd.startsWith("/")) return cmd;
  try {
    const cp = (window.require || require)("child_process") as typeof import("child_process");
    // Use login shell to resolve the command, picking up profile PATH
    const result = cp.spawnSync("/bin/zsh", ["-l", "-c", `which ${cmd}`], {
      timeout: 3000,
      encoding: "utf-8",
    });
    const resolved = result.stdout?.trim();
    if (resolved && resolved.startsWith("/")) {
      return resolved;
    }
  } catch { /* fall through */ }
  // Fallback: check common locations
  const home = process.env.HOME || "";
  const fs = (window.require || require)("fs") as typeof import("fs");
  const candidates = [
    `${home}/.local/bin/${cmd}`,
    `${home}/.claude/local/${cmd}`,
    `/usr/local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return cmd;
}

/** Claude sparkle logomark as inline SVG */
function createClaudeLogo(size = 14): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 110 130");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.style.verticalAlign = "middle";
  svg.style.marginRight = "4px";
  svg.style.flexShrink = "0";

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "m 29.05,98.54 29.14,-16.35 0.49,-1.42 -0.49,-0.79 h -1.42 l -4.87,-0.3 -16.65,-0.45 -14.44,-0.6 -13.99,-0.75 -3.52,-0.75 -3.3,-4.35 0.34,-2.17 2.96,-1.99 4.24,0.37 9.37,0.64 14.06,0.97 10.2,0.6 15.11,1.57 h 2.4 l 0.34,-0.97 -0.82,-0.6 -0.64,-0.6 -14.55,-9.86 -15.75,-10.42 -8.25,-6 -4.46,-3.04 -2.25,-2.85 -0.97,-6.22 4.05,-4.46 5.44,0.37 1.39,0.37 5.51,4.24 11.77,9.11 15.37,11.32 2.25,1.87 0.9,-0.64 0.11,-0.45 -1.01,-1.69 -8.36,-15.11 -8.92,-15.37 -3.97,-6.37 -1.05,-3.82 c -0.37,-1.57 -0.64,-2.89 -0.64,-4.5 l 4.61,-6.26 2.55,-0.82 6.15,0.82 2.59,2.25 3.82,8.74 6.19,13.76 9.6,18.71 2.81,5.55 1.5,5.14 0.56,1.57 h 0.97 v -0.9 l 0.79,-10.54 1.46,-12.94 1.42,-16.65 0.49,-4.69 2.32,-5.62 4.61,-3.04 3.6,1.72 2.96,4.24 -0.41,2.74 -1.76,11.44 -3.45,17.92 -2.25,12 h 1.31 l 1.5,-1.5 6.07,-8.06 10.2,-12.75 4.5,-5.06 5.25,-5.59 3.37,-2.66 h 6.37 l 4.69,6.97 -2.1,7.2 -6.56,8.32 -5.44,7.05 -7.8,10.5 -4.87,8.4 0.45,0.67 1.16,-0.11 17.62,-3.75 9.52,-1.72 11.36,-1.95 5.14,2.4 0.56,2.44 -2.02,4.99 -12.15,3 -14.25,2.85 -21.22,5.02 -0.26,0.19 0.3,0.37 9.56,0.9 4.09,0.22 h 10.01 l 18.64,1.39 4.87,3.22 2.92,3.94 -0.49,3 -7.5,3.82 -10.12,-2.4 -23.62,-5.62 -8.1,-2.02 h -1.12 v 0.67 l 6.75,6.6 12.37,11.17 15.49,14.4 0.79,3.56 -1.99,2.81 -2.1,-0.3 -13.61,-10.24 -5.25,-4.61 -11.89,-10.01 h -0.79 v 1.05 l 2.74,4.01 14.47,21.75 0.75,6.67 -1.05,2.17 -3.75,1.31 -4.12,-0.75 -8.47,-11.89 -8.74,-13.39 -7.05,-12 -0.86,0.49 -4.16,44.81 -1.95,2.29 -4.5,1.72 -3.75,-2.85 -1.99,-4.61 1.99,-9.11 2.4,-11.89 1.95,-9.45 1.76,-11.74 1.05,-3.9 -0.07,-0.26 -0.86,0.11 -8.85,12.15 -13.46,18.19 -10.65,11.4 -2.55,1.01 -4.42,-2.29 0.41,-4.09 2.47,-3.64 14.74,-18.75 8.89,-11.62 5.74,-6.71 -0.04,-0.97 h -0.34 l -39.15,25.42 -6.97,0.9 -3,-2.81 0.37,-4.61 1.42,-1.5 11.77,-8.1 -0.04,0.04 z");
  svg.appendChild(path);
  return svg;
}

export class TerminalPanel {
  private sessions: Map<string, TerminalTab[]> = new Map();
  private activeTask: TaskFile | null = null;
  private activeTabIndex = 0;
  private recoveredTaskPath: string | null = null;
  private recoveredTabIndex = 0;
  private tabBarEl: HTMLElement;
  private taskHeaderEl: HTMLElement;
  private terminalWrapperEl: HTMLElement;
  private placeholderEl: HTMLElement;
  private vaultPath: string;
  onSessionChange?: () => void;

  constructor(
    private containerEl: HTMLElement,
    private settings: TaskTerminalSettings,
    vaultPath: string
  ) {
    this.vaultPath = vaultPath;

    // Task info header
    this.taskHeaderEl = containerEl.createDiv({ cls: "terminal-task-header" });
    this.taskHeaderEl.style.display = "none";

    // Tab bar
    this.tabBarEl = containerEl.createDiv({ cls: "terminal-tab-bar" });
    this.tabBarEl.style.display = "none";

    // Terminal wrapper
    this.terminalWrapperEl = containerEl.createDiv({ cls: "terminal-wrapper" });

    // Placeholder
    this.placeholderEl = containerEl.createDiv({ cls: "terminal-placeholder" });
    const inner = this.placeholderEl.createDiv();
    inner.createDiv({ cls: "terminal-placeholder-icon", text: ">" });
    inner.createEl("p", {
      text: "Select a task from the kanban board to manage its terminals",
    });

    // Recover sessions from a previous reload
    const stored = SessionStore.retrieve();
    if (stored) {
      for (const [taskPath, storedSessions] of stored.sessions) {
        const tabs: TerminalTab[] = [];
        for (const ss of storedSessions) {
          const tab = TerminalTab.fromStored(ss, this.terminalWrapperEl);
          tab.onLabelChange = () => {
            if (this.activeTask?.path === taskPath) this.renderTabBar();
          };
          tab.hide();
          tabs.push(tab);
        }
        this.sessions.set(taskPath, tabs);
      }
      this.activeTabIndex = stored.activeTabIndex;
      this.recoveredTaskPath = stored.activeTaskPath;
      this.recoveredTabIndex = stored.activeTabIndex;
      console.log("[task-terminal] Recovered", this.sessions.size, "task groups");
    }

    this.renderTabBar();
  }

  /** Return recovered active task path from a previous reload (consumed once). */
  getRecoveredTaskPath(): string | null {
    const path = this.recoveredTaskPath;
    this.recoveredTaskPath = null;
    return path;
  }

  setTask(task: TaskFile | null): void {
    // Hide all current terminals
    this.hideAllTerminals();

    this.activeTask = task;
    this.activeTabIndex = 0;

    if (!task) {
      this.placeholderEl.style.display = "flex";
      this.tabBarEl.style.display = "none";
      this.taskHeaderEl.style.display = "none";
      return;
    }

    this.placeholderEl.style.display = "none";
    this.tabBarEl.style.display = "flex";
    this.taskHeaderEl.style.display = "flex";
    this.terminalWrapperEl.style.display = "block";

    // Update header
    this.taskHeaderEl.empty();
    this.taskHeaderEl.createSpan({ cls: "task-title", text: task.title });

    // Show existing terminals or show empty state
    const tabs = this.sessions.get(task.path) || [];
    if (tabs.length > 0) {
      // Restore recovered tab index if this is a reload re-selection
      const targetIdx = (this.recoveredTabIndex > 0 && this.recoveredTabIndex < tabs.length)
        ? this.recoveredTabIndex : 0;
      this.recoveredTabIndex = 0;
      tabs[targetIdx].show();
      this.activeTabIndex = targetIdx;
    }

    this.renderTabBar();
  }

  private createTerminal(preCommand?: string, customLabel?: string): void {
    if (!this.activeTask) return;

    const taskPath = this.activeTask.path;
    const tabs = this.sessions.get(taskPath) || [];
    const label = customLabel
      || (preCommand?.startsWith("claude") ? `Claude ${tabs.length + 1}` : `Shell ${tabs.length + 1}`);

    const cwd =
      this.settings.defaultTerminalCwd || this.vaultPath;

    const tab = new TerminalTab(
      this.terminalWrapperEl,
      this.settings.defaultShell,
      cwd,
      label,
      taskPath,
      preCommand
    );
    tab.onLabelChange = () => {
      if (this.activeTask?.path === taskPath) this.renderTabBar();
    };
    tab.onProcessExit = () => {
      const idx = tabs.indexOf(tab);
      if (idx !== -1) this.closeTab(idx);
    };

    tabs.push(tab);
    this.sessions.set(taskPath, tabs);

    // Hide others, show new
    this.hideAllTerminals();
    tab.show();
    this.activeTabIndex = tabs.length - 1;

    this.renderTabBar();
    this.onSessionChange?.();
  }

  private createTerminalWithArgs(command: string[], label: string): void {
    if (!this.activeTask) return;

    const taskPath = this.activeTask.path;
    const tabs = this.sessions.get(taskPath) || [];
    const cwd = this.settings.defaultTerminalCwd || this.vaultPath;

    const tab = new TerminalTab(
      this.terminalWrapperEl,
      this.settings.defaultShell,
      cwd,
      label,
      taskPath,
      undefined,
      command
    );
    tab.onLabelChange = () => {
      if (this.activeTask?.path === taskPath) this.renderTabBar();
    };
    tab.onProcessExit = () => {
      const idx = tabs.indexOf(tab);
      if (idx !== -1) this.closeTab(idx);
    };

    tabs.push(tab);
    this.sessions.set(taskPath, tabs);

    this.hideAllTerminals();
    tab.show();
    this.activeTabIndex = tabs.length - 1;
    this.renderTabBar();
    this.onSessionChange?.();
  }

  private switchToTab(index: number): void {
    if (!this.activeTask) return;
    const tabs = this.sessions.get(this.activeTask.path) || [];
    if (index < 0 || index >= tabs.length) return;

    this.hideAllTerminals();
    tabs[index].show();
    this.activeTabIndex = index;
    this.renderTabBar();
  }

  private closeTab(index: number): void {
    if (!this.activeTask) return;
    const tabs = this.sessions.get(this.activeTask.path) || [];
    if (index < 0 || index >= tabs.length) return;

    tabs[index].dispose();
    tabs.splice(index, 1);

    if (tabs.length === 0) {
      this.sessions.delete(this.activeTask.path);
      this.activeTabIndex = 0;
    } else {
      this.activeTabIndex = Math.min(this.activeTabIndex, tabs.length - 1);
      tabs[this.activeTabIndex].show();
    }

    this.renderTabBar();
    this.onSessionChange?.();
  }

  private hideAllTerminals(): void {
    for (const tabs of this.sessions.values()) {
      for (const tab of tabs) {
        tab.hide();
      }
    }
  }

  private renderTabBar(): void {
    this.tabBarEl.empty();

    if (!this.activeTask) return;

    const tabs = this.sessions.get(this.activeTask.path) || [];

    for (let i = 0; i < tabs.length; i++) {
      const tabEl = this.tabBarEl.createDiv({ cls: "terminal-tab" });
      const isActive = i === this.activeTabIndex;
      if (isActive) tabEl.addClass("active");

      const labelSpan = tabEl.createSpan({
        cls: "terminal-tab-label",
        text: tabs[i].session.label,
      });

      // Click-to-edit: clicking the label of the already-active tab enters edit mode
      if (isActive) {
        labelSpan.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          // Prevent double-edit if already in edit mode
          if (tabEl.querySelector(".terminal-tab-edit")) return;

          const currentLabel = tabs[i].session.label;
          const input = document.createElement("input");
          input.type = "text";
          input.value = currentLabel;
          input.className = "terminal-tab-edit";

          // Guard against premature blur (Obsidian/terminal stealing focus).
          // The input is only "armed" after a short delay so the initial
          // focus-shuffle doesn't trigger a commit.
          let armed = false;
          let committed = false;

          const commit = () => {
            if (committed) return;
            committed = true;
            const newLabel = input.value.trim() || currentLabel;
            tabs[i].session.label = newLabel;
            this.renderTabBar();
          };

          input.addEventListener("blur", () => {
            if (!armed) {
              // Focus was stolen before arming - reclaim it
              requestAnimationFrame(() => {
                if (!committed && input.isConnected) {
                  input.focus();
                }
              });
              return;
            }
            commit();
          });

          input.addEventListener("keydown", (ke) => {
            if (ke.key === "Enter") { ke.preventDefault(); armed = true; input.blur(); }
            if (ke.key === "Escape") { input.value = currentLabel; armed = true; input.blur(); }
            ke.stopPropagation(); // prevent terminal/Obsidian from stealing keys
          });

          // Also stop mousedown propagation to prevent Obsidian focus handling
          input.addEventListener("mousedown", (me) => me.stopPropagation());

          labelSpan.replaceWith(input);
          input.focus();
          input.select();

          // Arm the blur-to-commit after focus has settled
          setTimeout(() => { armed = true; }, 200);
        });
      }

      const closeBtn = tabEl.createSpan({ cls: "terminal-tab-close" });
      closeBtn.textContent = "\u00d7";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(i);
      });

      tabEl.addEventListener("click", () => this.switchToTab(i));
    }

    // Spacer between session tabs and new-tab buttons
    const spacer = this.tabBarEl.createDiv({ cls: "terminal-tab-spacer" });
    spacer.style.width = "12px";
    spacer.style.flexShrink = "0";

    // New terminal button
    const newBtn = this.tabBarEl.createDiv({
      cls: "terminal-tab-btn",
      text: "+ Shell",
    });
    newBtn.addEventListener("click", () => this.createTerminal());

    // Build base claude args with plugin dirs
    const pluginBase = (process.env.HOME || "") + "/working/claude-sandbox/plugins";
    const claudeCmd = resolveCommand(this.settings.claudeCommand);
    const claudeBaseArgs = [
      claudeCmd,
      "--dangerously-skip-permissions",
      "--plugin-dir", pluginBase + "/tc-services",
      "--plugin-dir", pluginBase + "/tc-tools",
      "--plugin-dir", pluginBase + "/tc-tasks",
      "--plugin-dir", pluginBase + "/tc-core",
    ];

    // Launch Claude button
    const claudeBtn = this.tabBarEl.createDiv({
      cls: "terminal-tab-btn claude-btn",
    });
    claudeBtn.appendChild(createClaudeLogo());
    claudeBtn.appendText("Claude");
    claudeBtn.addEventListener("click", () => {
      const tabs = this.sessions.get(this.activeTask!.path) || [];
      this.createTerminalWithArgs(
        [...claudeBaseArgs],
        `Claude ${tabs.length + 1}`
      );
    });

    // Launch Claude with lightweight task context prompt
    const taskBtn = this.tabBarEl.createDiv({
      cls: "terminal-tab-btn claude-btn task-agent-btn",
    });
    taskBtn.appendChild(createClaudeLogo());
    taskBtn.appendText("Task Agent");
    taskBtn.addEventListener("click", () => {
      if (!this.activeTask) return;
      const task = this.activeTask;
      const home = process.env.HOME || process.env.USERPROFILE || "";
      let fullPath = this.vaultPath + "/" + task.path;
      if (fullPath.startsWith("~/")) {
        fullPath = home + fullPath.slice(1);
      }

      // Build lightweight context prompt from parsed task metadata
      const parts: string[] = [
        `Task: "${task.title}"`,
        `State: ${task.state}`,
        `File: ${fullPath}`,
      ];
      if (task.source.type !== "prompt" && task.source.id) {
        parts.push(`Source: ${task.source.type} ${task.source.id}`);
      }
      if (task.source.url) {
        parts.push(`URL: ${task.source.url}`);
      }
      if (task.priority.deadline) {
        parts.push(`Deadline: ${task.priority.deadline}`);
      }
      if (task.priority["has-blocker"]) {
        parts.push(`BLOCKED: ${task.priority["blocker-context"]}`);
      }

      const prompt = [
        parts.join(" | "),
        "",
        `Read the task file at ${fullPath} for full context (enrichment notes, next steps, activity log).`,
        "Respond briefly with just the task title and current state to confirm you've loaded it.",
        "The /tc-tasks:task-agent skill is available for full task management operations if needed.",
      ].join("\n");

      const tabs = this.sessions.get(task.path) || [];
      this.createTerminalWithArgs(
        [...claudeBaseArgs, prompt],
        `Agent ${tabs.length + 1}`
      );
    });
  }

  /** Return the count of shell and Claude tabs for a given task path */
  getSessionCounts(taskPath: string): { shells: number; claudes: number } {
    const tabs = this.sessions.get(taskPath) || [];
    let claudes = 0;
    let shells = 0;
    for (const tab of tabs) {
      const label = tab.session.label.toLowerCase();
      if (label.startsWith("claude") || label.startsWith("agent")) {
        claudes++;
      } else {
        shells++;
      }
    }
    return { shells, claudes };
  }

  /** Re-fit the active terminal to its container dimensions */
  refitActive(): void {
    if (!this.activeTask) return;
    const tabs = this.sessions.get(this.activeTask.path) || [];
    if (tabs.length > 0 && this.activeTabIndex < tabs.length) {
      tabs[this.activeTabIndex].refit();
    }
  }

  rekeyTask(oldPath: string, newPath: string): void {
    const tabs = this.sessions.get(oldPath);
    if (!tabs) return;

    this.sessions.delete(oldPath);
    this.sessions.set(newPath, tabs);

    // Update taskPath on each tab's session
    for (const tab of tabs) {
      tab.session.taskPath = newPath;
    }

    // Update activeTask reference if it matches
    if (this.activeTask && this.activeTask.path === oldPath) {
      this.activeTask = { ...this.activeTask, path: newPath };
    }
  }

  /**
   * Stash all sessions into the global store for reload recovery.
   * Does NOT kill processes or dispose terminals.
   */
  stashAll(): void {
    const stashMap = new Map<string, import("./SessionStore").StoredSession[]>();
    for (const [taskPath, tabs] of this.sessions) {
      stashMap.set(taskPath, tabs.map(t => t.stash()));
    }
    SessionStore.stash(
      stashMap,
      this.activeTask?.path || null,
      this.activeTabIndex
    );
    // Clear local references without disposing
    this.sessions.clear();
  }

  disposeAll(): void {
    for (const tabs of this.sessions.values()) {
      for (const tab of tabs) {
        tab.dispose();
      }
    }
    this.sessions.clear();
  }
}
