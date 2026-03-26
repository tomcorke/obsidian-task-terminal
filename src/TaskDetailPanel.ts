import { type App, MarkdownRenderer, Component, type TFile } from "obsidian";
import type { TaskFile } from "./types";

export class TaskDetailPanel extends Component {
  private currentTask: TaskFile | null = null;
  private headerEl: HTMLElement;
  private contentEl: HTMLElement;
  private placeholderEl: HTMLElement;

  constructor(
    private containerEl: HTMLElement,
    private app: App
  ) {
    super();
    this.containerEl.addClass("task-detail-panel");

    // Header with title and edit button
    this.headerEl = containerEl.createDiv({ cls: "task-detail-header" });
    this.headerEl.style.display = "none";

    // Scrollable content area
    this.contentEl = containerEl.createDiv({ cls: "task-detail-content" });

    // Placeholder
    this.placeholderEl = containerEl.createDiv({ cls: "task-detail-placeholder" });
    this.placeholderEl.createDiv({ text: "Select a task to view details" });
  }

  async setTask(task: TaskFile | null): Promise<void> {
    this.currentTask = task;

    if (!task) {
      this.headerEl.style.display = "none";
      this.contentEl.empty();
      this.contentEl.style.display = "none";
      this.placeholderEl.style.display = "flex";
      return;
    }

    this.placeholderEl.style.display = "none";
    this.headerEl.style.display = "flex";
    this.contentEl.style.display = "block";

    // Update header
    this.headerEl.empty();
    this.headerEl.createSpan({ cls: "task-detail-title", text: task.title });
    const editBtn = this.headerEl.createEl("button", {
      cls: "task-detail-edit-btn",
      text: "Open in Editor",
    });
    editBtn.addEventListener("click", () => this.openInEditor());

    // Render content
    await this.renderContent(task);
  }

  private async renderContent(task: TaskFile): Promise<void> {
    this.contentEl.empty();

    const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
    if (!file) {
      this.contentEl.createDiv({ text: "File not found", cls: "task-detail-error" });
      return;
    }

    const content = await this.app.vault.read(file);
    await MarkdownRenderer.render(this.app, content, this.contentEl, task.path, this);
  }

  private openInEditor(): void {
    if (!this.currentTask) return;

    const file = this.app.vault.getAbstractFileByPath(this.currentTask.path) as TFile;
    if (!file) return;

    // Open in a new tab
    this.app.workspace.getLeaf("tab").openFile(file);
  }

  async refreshIfShowing(path: string): Promise<void> {
    if (this.currentTask && this.currentTask.path === path) {
      await this.renderContent(this.currentTask);
    }
  }

  getCurrentTaskPath(): string | null {
    return this.currentTask?.path ?? null;
  }
}
