import { Plugin, PluginSettingTab, App, Setting } from "obsidian";
import {
  VIEW_TYPE_TASK_TERMINAL,
  type TaskTerminalSettings,
  DEFAULT_SETTINGS,
} from "./types";
import { TaskTerminalView } from "./TaskTerminalView";

/** Per-section ordered list of task paths. Paths not in the list go to the end (default sort). */
export type TaskOrder = Record<string, string[]>;

export default class TaskTerminalPlugin extends Plugin {
  settings: TaskTerminalSettings = DEFAULT_SETTINGS;
  taskOrder: TaskOrder = {};

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_TASK_TERMINAL,
      (leaf) => new TaskTerminalView(leaf, this)
    );

    this.addRibbonIcon("terminal", "Task Terminal", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-task-terminal",
      name: "Open Task Terminal",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new TaskTerminalSettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_TASK_TERMINAL)[0];

    if (!leaf) {
      const newLeaf = workspace.getLeaf("tab");
      await newLeaf.setViewState({
        type: VIEW_TYPE_TASK_TERMINAL,
        active: true,
      });
      leaf = newLeaf;
    }

    workspace.revealLeaf(leaf);
  }

  onunload(): void {
    // Views are automatically cleaned up by Obsidian
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.taskOrder = data.taskOrder || {};
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, taskOrder: this.taskOrder });
  }

  async saveTaskOrder(): Promise<void> {
    await this.saveData({ ...this.settings, taskOrder: this.taskOrder });
  }
}

class TaskTerminalSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TaskTerminalPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Task Terminal Settings" });

    new Setting(containerEl)
      .setName("Task base path")
      .setDesc("Vault-relative path to the Tasks directory (contains priority/, todo/, active/, archive/)")
      .addText((text) =>
        text
          .setPlaceholder("2 - Areas/Tasks")
          .setValue(this.plugin.settings.taskBasePath)
          .onChange(async (value) => {
            this.plugin.settings.taskBasePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default shell")
      .setDesc("Shell to use for new terminal tabs")
      .addText((text) =>
        text
          .setPlaceholder("/bin/zsh")
          .setValue(this.plugin.settings.defaultShell)
          .onChange(async (value) => {
            this.plugin.settings.defaultShell = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Claude command")
      .setDesc("Command to launch Claude CLI in terminal tabs")
      .addText((text) =>
        text
          .setPlaceholder("claude")
          .setValue(this.plugin.settings.claudeCommand)
          .onChange(async (value) => {
            this.plugin.settings.claudeCommand = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default terminal working directory")
      .setDesc("Working directory for new terminals (blank = vault root)")
      .addText((text) =>
        text
          .setPlaceholder("Leave blank for vault root")
          .setValue(this.plugin.settings.defaultTerminalCwd)
          .onChange(async (value) => {
            this.plugin.settings.defaultTerminalCwd = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
