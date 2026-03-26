import type { TaskFile, TaskTerminalSettings } from "./types";
import { TerminalTab } from "./TerminalTab";

export class TerminalPanel {
  private sessions: Map<string, TerminalTab[]> = new Map();
  private activeTask: TaskFile | null = null;
  private activeTabIndex = 0;
  private tabBarEl: HTMLElement;
  private taskHeaderEl: HTMLElement;
  private terminalWrapperEl: HTMLElement;
  private placeholderEl: HTMLElement;
  private vaultPath: string;

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

    this.renderTabBar();
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
      tabs[0].show();
      this.activeTabIndex = 0;
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
    tab.onLabelChange = () => this.renderTabBar();

    tabs.push(tab);
    this.sessions.set(taskPath, tabs);

    // Hide others, show new
    this.hideAllTerminals();
    tab.show();
    this.activeTabIndex = tabs.length - 1;

    this.renderTabBar();
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
    tab.onLabelChange = () => this.renderTabBar();

    tabs.push(tab);
    this.sessions.set(taskPath, tabs);

    this.hideAllTerminals();
    tab.show();
    this.activeTabIndex = tabs.length - 1;
    this.renderTabBar();
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
      if (i === this.activeTabIndex) tabEl.addClass("active");

      tabEl.createSpan({ text: tabs[i].session.label });

      const closeBtn = tabEl.createSpan({ cls: "terminal-tab-close" });
      closeBtn.textContent = "\u00d7";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(i);
      });

      tabEl.addEventListener("click", () => this.switchToTab(i));
    }

    // New terminal button
    const newBtn = this.tabBarEl.createDiv({
      cls: "terminal-tab-btn",
      text: "+ Shell",
    });
    newBtn.addEventListener("click", () => this.createTerminal());

    // Build base claude args with plugin dirs
    const pluginBase = (process.env.HOME || "") + "/working/claude-sandbox/plugins";
    const claudeBaseArgs = [
      this.settings.claudeCommand,
      "--dangerously-skip-permissions",
      "--plugin-dir", pluginBase + "/tc-services",
      "--plugin-dir", pluginBase + "/tc-tools",
      "--plugin-dir", pluginBase + "/tc-tasks",
      "--plugin-dir", pluginBase + "/tc-core",
    ];

    // Launch Claude button
    const claudeBtn = this.tabBarEl.createDiv({
      cls: "terminal-tab-btn claude-btn",
      text: "+ Claude",
    });
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
      text: "+ Task Agent",
    });
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

  disposeAll(): void {
    for (const tabs of this.sessions.values()) {
      for (const tab of tabs) {
        tab.dispose();
      }
    }
    this.sessions.clear();
  }
}
