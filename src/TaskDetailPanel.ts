import { type App, type TFile, type WorkspaceLeaf } from "obsidian";
import type { TaskFile } from "./types";

/**
 * Manages an Obsidian editor leaf for viewing/editing the selected task file.
 * Uses a real MarkdownView (via workspace leaf) so the user gets the full
 * Obsidian editing experience including live preview, frontmatter, links, etc.
 *
 * The middle panel div in our layout hosts a placeholder when no task is
 * selected. When a task IS selected, the placeholder hides and we open the
 * file in a managed workspace leaf (created once via split).
 */
export class TaskDetailPanel {
  private currentTask: TaskFile | null = null;
  private placeholderEl: HTMLElement;
  private editorLeaf: WorkspaceLeaf | null = null;
  private ownerLeaf: WorkspaceLeaf;

  constructor(
    private containerEl: HTMLElement,
    private app: App,
    ownerLeaf: WorkspaceLeaf
  ) {
    this.ownerLeaf = ownerLeaf;
    this.containerEl.addClass("task-detail-panel");

    // Placeholder shown when no task selected
    this.placeholderEl = containerEl.createDiv({ cls: "task-detail-placeholder" });
    this.placeholderEl.createDiv({ text: "Select a task to view details" });
  }

  async setTask(task: TaskFile | null): Promise<void> {
    this.currentTask = task;

    if (!task) {
      this.placeholderEl.style.display = "flex";
      this.hideEditorLeaf();
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
    if (!file) return;

    this.placeholderEl.style.display = "none";

    // Create or reuse the editor leaf
    await this.ensureEditorLeaf();

    if (this.editorLeaf) {
      await this.editorLeaf.openFile(file);
    }
  }

  private async ensureEditorLeaf(): Promise<void> {
    // Check if our leaf is still alive
    if (this.editorLeaf) {
      const found = this.app.workspace.getLeavesOfType("markdown")
        .some(l => l === this.editorLeaf);
      if (!found) {
        this.editorLeaf = null;
      }
    }

    if (this.editorLeaf) return;

    // Create a new leaf by splitting our owner leaf
    // 'vertical' = side by side, and the new leaf appears to the right
    this.editorLeaf = this.app.workspace.createLeafBySplit(
      this.ownerLeaf,
      "vertical",
      false // new leaf to the right
    );

    // Set 65:35 split ratio (task-terminal : editor)
    // Defer so Obsidian's layout pass completes first
    setTimeout(() => this.applySplitRatio(65, 35), 100);
  }

  private applySplitRatio(leftPct: number, rightPct: number): void {
    if (!this.editorLeaf) return;
    const parent = this.editorLeaf.parent as any;
    if (!parent || !parent.children || parent.children.length < 2) return;

    // Obsidian split children have a containerEl we can style with flex
    const leftChild = parent.children[0];
    const rightChild = parent.children[1];

    if (leftChild?.containerEl) {
      leftChild.containerEl.style.flexGrow = String(leftPct);
      leftChild.containerEl.style.flexShrink = "1";
      leftChild.containerEl.style.flexBasis = "0%";
    }
    if (rightChild?.containerEl) {
      rightChild.containerEl.style.flexGrow = String(rightPct);
      rightChild.containerEl.style.flexShrink = "1";
      rightChild.containerEl.style.flexBasis = "0%";
    }
  }

  private hideEditorLeaf(): void {
    // We don't detach the leaf - just leave it showing the last file
    // This avoids destroying/recreating leaves on every deselect
  }

  async refreshIfShowing(path: string): Promise<void> {
    // The Obsidian editor auto-refreshes when the file changes on disk,
    // so we don't need to do anything here
  }

  getCurrentTaskPath(): string | null {
    return this.currentTask?.path ?? null;
  }

  detachLeaf(): void {
    if (this.editorLeaf) {
      this.editorLeaf.detach();
      this.editorLeaf = null;
    }
  }

  unload(): void {
    this.detachLeaf();
  }
}
