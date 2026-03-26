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

  private createTerminal(preCommand?: string): void {
    if (!this.activeTask) return;

    const taskPath = this.activeTask.path;
    const tabs = this.sessions.get(taskPath) || [];
    const label = preCommand?.startsWith("claude")
      ? `Claude ${tabs.length + 1}`
      : `Shell ${tabs.length + 1}`;

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

    tabs.push(tab);
    this.sessions.set(taskPath, tabs);

    // Hide others, show new
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

    // Launch Claude button
    const claudeBtn = this.tabBarEl.createDiv({
      cls: "terminal-tab-btn claude-btn",
      text: "+ Claude",
    });
    claudeBtn.addEventListener("click", () =>
      this.createTerminal(this.settings.claudeCommand)
    );
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
