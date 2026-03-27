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
  // Track whether we created the leaf (true) or adopted an existing one (false).
  // We only detach leaves we created - adopted leaves belong to the user.
  private leafIsOwned = false;

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
    // Check if our managed leaf is still alive
    if (this.editorLeaf) {
      const found = this.app.workspace.getLeavesOfType("markdown")
        .some(l => l === this.editorLeaf);
      if (!found) {
        this.editorLeaf = null;
        this.leafIsOwned = false;
      }
    }

    if (this.editorLeaf) return;

    // Before creating a new split, try to reuse an existing rightmost editor leaf.
    // This avoids creating extra panes when the user already has an editor open.
    const rightmostEditor = this.findRightmostEditorLeaf();
    if (rightmostEditor) {
      this.editorLeaf = rightmostEditor;
      this.leafIsOwned = false;
      return;
    }

    // No existing editor leaf to reuse - create one by splitting our owner leaf
    this.leafIsOwned = true;
    this.editorLeaf = this.app.workspace.createLeafBySplit(
      this.ownerLeaf,
      "vertical",
      false // new leaf to the right
    );

    // Set the editor leaf to the minimum width that avoids text wrapping.
    // Obsidian's readable line width is controlled by --file-line-width (default 700px).
    // We read it at runtime so we respect the user's theme/settings.
    // Defer so Obsidian's layout pass completes first.
    setTimeout(() => this.applyMinEditorWidth(), 100);
  }

  /**
   * Find the rightmost editor (markdown) leaf in the root split.
   * Walks the workspace split tree right-to-left, returning the first
   * markdown leaf found in the rightmost split that isn't our plugin view.
   */
  private findRightmostEditorLeaf(): WorkspaceLeaf | null {
    const rootSplit = this.app.workspace.rootSplit;
    if (!rootSplit) return null;

    // Collect all leaves from the root split in document order
    const leaves: WorkspaceLeaf[] = [];
    this.collectLeaves(rootSplit, leaves);

    // Walk right-to-left looking for a markdown (editor) leaf
    for (let i = leaves.length - 1; i >= 0; i--) {
      const leaf = leaves[i];
      if (leaf.view?.getViewType() === "markdown") {
        return leaf;
      }
    }

    return null;
  }

  /** Recursively collect all leaves from a workspace split in document order. */
  private collectLeaves(node: any, result: WorkspaceLeaf[]): void {
    if (node.children) {
      for (const child of node.children) {
        this.collectLeaves(child, result);
      }
    } else if (node.view) {
      // This is a leaf
      result.push(node as WorkspaceLeaf);
    }
  }

  private applyMinEditorWidth(): void {
    if (!this.editorLeaf) return;

    // createLeafBySplit wraps each side in its own split container, so the
    // two siblings we need to resize live one level higher than editorLeaf.parent.
    const editorSplit = (this.editorLeaf as any).parent;
    const rootSplit = editorSplit?.parent;
    if (!rootSplit?.children || rootSplit.children.length < 2) return;

    // Identify which child is the editor split and which is the task-terminal split
    const editorIdx = rootSplit.children.indexOf(editorSplit);
    if (editorIdx === -1) return;
    const ttIdx = editorIdx === 0 ? 1 : 0;

    const editorChild = rootSplit.children[editorIdx];
    const ttChild = rootSplit.children[ttIdx];

    // Read Obsidian's readable line width from CSS variable, fallback 700px
    const rootStyle = getComputedStyle(document.body);
    const lineWidthRaw = rootStyle.getPropertyValue("--file-line-width").trim();
    const lineWidth = parseInt(lineWidthRaw, 10) || 700;

    // Add padding for gutters, scrollbar, and editor chrome
    const editorWidth = lineWidth + 80;

    // Editor split: fixed width, no grow
    if (editorChild?.containerEl) {
      editorChild.containerEl.style.flexGrow = "0";
      editorChild.containerEl.style.flexShrink = "0";
      editorChild.containerEl.style.flexBasis = `${editorWidth}px`;
    }
    // Task-terminal split: fill remaining space
    if (ttChild?.containerEl) {
      ttChild.containerEl.style.flexGrow = "1";
      ttChild.containerEl.style.flexShrink = "1";
      ttChild.containerEl.style.flexBasis = "0%";
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
      // Only detach leaves we created via split - leave adopted leaves intact
      if (this.leafIsOwned) {
        this.editorLeaf.detach();
      }
      this.editorLeaf = null;
      this.leafIsOwned = false;
    }
  }

  unload(): void {
    this.detachLeaf();
  }
}
