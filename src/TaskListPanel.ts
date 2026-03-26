import type { App, TFile } from "obsidian";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { TaskCard } from "./TaskCard";
import {
  type TaskFile,
  type KanbanColumn,
  type ClaudeState,
  KANBAN_COLUMNS,
  COLUMN_LABELS,
  STATE_FOLDER_MAP,
} from "./types";
import type { TaskOrder } from "./main";

function buildContextPrompt(task: TaskFile, fullPath: string): string {
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
  return [
    parts.join(" | "),
    "",
    `Read the task file at ${fullPath} for full context (enrichment notes, next steps, activity log).`,
    "Respond briefly with just the task title and current state to confirm you've loaded it.",
    "The /tc-tasks:task-agent skill is available for full task management operations if needed.",
  ].join("\n");
}

/** A placeholder card shown while a task is being created by Claude. */
interface PendingPlaceholder {
  id: string;
  prompt: string;
  column: KanbanColumn;
  el: HTMLElement;
  state: "creating" | "done" | "error";
}

export class TaskListPanel {
  private cards: Map<string, TaskCard> = new Map();
  private selectedPath: string | null = null;
  private sectionEls: Map<KanbanColumn, HTMLElement> = new Map();
  private sectionCardsEls: Map<KanbanColumn, HTMLElement> = new Map();
  private collapsedSections: Set<KanbanColumn> = new Set(["done"]);
  private filterTerm = "";
  private dragSourcePath: string | null = null;
  private dropIndicator: HTMLElement;
  private placeholders: Map<string, PendingPlaceholder> = new Map();
  private ingestingPaths: Set<string> = new Set();

  constructor(
    private containerEl: HTMLElement,
    private app: App,
    private parser: TaskParser,
    private mover: TaskMover,
    private taskOrder: TaskOrder,
    private vaultPath: string,
    private onTaskSelect: (task: TaskFile | null) => void,
    private onOrderChange: (order: TaskOrder) => void,
    private getSessionCount?: (path: string) => { shells: number; claudes: number },
    private onSplitComplete?: (newPath: string, originalTitle: string) => void,
    private onCloseSessions?: (path: string) => void,
    private hasResumableSession?: (taskPath: string) => boolean,
    private onResumeSession?: (task: TaskFile) => void
  ) {
    this.containerEl.addClass("task-list-panel");

    // Shared drop indicator element
    this.dropIndicator = document.createElement("div");
    this.dropIndicator.addClass("task-drop-indicator");
  }

  async render(): Promise<void> {
    this.containerEl.empty();
    this.cards.clear();
    this.sectionEls.clear();
    this.sectionCardsEls.clear();

    const tasks = await this.parser.loadAllTasks();
    const groups = this.parser.groupByColumn(tasks);

    for (const col of KANBAN_COLUMNS) {
      const section = this.containerEl.createDiv({ cls: "task-list-section" });
      section.dataset.section = col;
      this.sectionEls.set(col, section);

      // Header
      const header = section.createDiv({ cls: "task-list-section-header" });
      const headerLeft = header.createDiv({ cls: "section-header-left" });
      const chevron = headerLeft.createSpan({ cls: "section-chevron" });
      chevron.textContent = "\u25B6";
      headerLeft.createSpan({ cls: "section-title", text: COLUMN_LABELS[col] });
      header.createSpan({ cls: "section-count", text: String(groups[col].length) });

      header.addEventListener("click", () => this.toggleSection(col));

      // Cards container
      const cardsEl = section.createDiv({ cls: "task-list-section-cards" });
      this.sectionCardsEls.set(col, cardsEl);

      // Sort tasks by custom order, falling back to default sort
      const orderedTasks = this.applyCustomOrder(groups[col], col);

      for (const task of orderedTasks) {
        const card = new TaskCard(
          task,
          col,
          (t) => this.selectTask(t),
          (t) => this.moveToTop(t.path, col),
          this.getSessionCount,
          (t, targetCol) => this.contextMove(t, targetCol),
          (t) => this.copyName(t),
          (t) => this.copyPath(t),
          (t) => this.copyPrompt(t),
          (t) => this.splitTask(t, col),
          (t) => this.deleteTask(t),
          (t) => this.completeAndClose(t),
          this.ingestingPaths.has(task.path),
          this.hasResumableSession?.(task.path) || false,
          this.onResumeSession
        );
        this.cards.set(task.path, card);
        cardsEl.appendChild(card.el);
      }

      // Drop zone for the section (handles cross-section moves + reordering)
      this.setupDropZone(section, cardsEl, col);

      // Apply collapsed state
      if (this.collapsedSections.has(col)) {
        section.addClass("collapsed");
      }
    }

    // Re-insert any active placeholder cards at the top of their target column
    for (const placeholder of this.placeholders.values()) {
      if (placeholder.state === "creating") {
        const cardsEl = this.sectionCardsEls.get(placeholder.column);
        if (cardsEl) {
          cardsEl.prepend(placeholder.el);
        }
      }
    }

    // Apply current filter
    if (this.filterTerm) {
      this.applyFilter();
    }

    // Restore selection
    if (this.selectedPath) {
      this.cards.get(this.selectedPath)?.setSelected(true);
    }
  }

  /** Sort tasks by custom order. Tasks not in the order list go at the end in default sort. */
  private applyCustomOrder(tasks: TaskFile[], col: KanbanColumn): TaskFile[] {
    const order = this.taskOrder[col];
    if (!order || order.length === 0) return tasks;

    const orderMap = new Map<string, number>();
    order.forEach((path, i) => orderMap.set(path, i));

    const ordered: TaskFile[] = [];
    const unordered: TaskFile[] = [];

    for (const task of tasks) {
      if (orderMap.has(task.path)) {
        ordered.push(task);
      } else {
        unordered.push(task);
      }
    }

    ordered.sort((a, b) => (orderMap.get(a.path) ?? 0) - (orderMap.get(b.path) ?? 0));
    return [...ordered, ...unordered];
  }

  private toggleSection(col: KanbanColumn): void {
    const section = this.sectionEls.get(col);
    if (!section) return;

    if (this.collapsedSections.has(col)) {
      this.collapsedSections.delete(col);
      section.removeClass("collapsed");
    } else {
      this.collapsedSections.add(col);
      section.addClass("collapsed");
    }
  }

  private setupDropZone(
    sectionEl: HTMLElement,
    cardsEl: HTMLElement,
    column: KanbanColumn
  ): void {
    cardsEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

      // Auto-expand collapsed section on drag over
      if (this.collapsedSections.has(column)) {
        this.collapsedSections.delete(column);
        sectionEl.removeClass("collapsed");
      }

      sectionEl.addClass("drag-over");

      // Position drop indicator
      this.positionDropIndicator(cardsEl, e.clientY);
    });

    sectionEl.querySelector(".task-list-section-header")?.addEventListener("dragover", (e) => {
      e.preventDefault();
      if ((e as DragEvent).dataTransfer) (e as DragEvent).dataTransfer!.dropEffect = "move";

      if (this.collapsedSections.has(column)) {
        this.collapsedSections.delete(column);
        sectionEl.removeClass("collapsed");
      }

      sectionEl.addClass("drag-over");
    });

    sectionEl.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !sectionEl.contains(related)) {
        sectionEl.removeClass("drag-over");
        this.hideDropIndicator();
      }
    });

    sectionEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      sectionEl.removeClass("drag-over");
      this.hideDropIndicator();

      const taskPath = e.dataTransfer?.getData("text/plain");
      if (!taskPath) return;

      const file = this.app.vault.getAbstractFileByPath(taskPath) as TFile;
      if (!file) return;

      // Determine source section
      const sourceCard = this.cards.get(taskPath);
      const sourceSection = sourceCard?.el.closest(".task-list-section")?.dataset.section as KanbanColumn | undefined;

      if (sourceSection === column) {
        // Same section - reorder
        const dropIndex = this.getDropIndex(cardsEl, e.clientY);
        this.reorderInSection(column, taskPath, dropIndex);
      } else {
        // Different section - move task state
        const dropIndex = this.getDropIndex(cardsEl, e.clientY);
        await this.mover.moveTask(file, column);
        // Compute the new path after move (file.name stays the same, folder changes)
        const newPath = `${this.parser.basePath}/${STATE_FOLDER_MAP[column]}/${file.name}`;
        setTimeout(() => {
          this.render().then(() => {
            this.reorderAfterMove(column, newPath, dropIndex);
          });
        }, 200);
      }
    });
  }

  private positionDropIndicator(cardsEl: HTMLElement, clientY: number): void {
    const cards = Array.from(cardsEl.querySelectorAll<HTMLElement>(".task-card:not(.dragging)"));

    // Remove indicator from previous position
    if (this.dropIndicator.parentElement) {
      this.dropIndicator.remove();
    }

    if (cards.length === 0) {
      cardsEl.appendChild(this.dropIndicator);
      return;
    }

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      if (clientY < midY) {
        cardsEl.insertBefore(this.dropIndicator, cards[i]);
        return;
      }
    }

    // After last card
    cardsEl.appendChild(this.dropIndicator);
  }

  private hideDropIndicator(): void {
    if (this.dropIndicator.parentElement) {
      this.dropIndicator.remove();
    }
  }

  private getDropIndex(cardsEl: HTMLElement, clientY: number): number {
    const cards = Array.from(cardsEl.querySelectorAll<HTMLElement>(".task-card:not(.dragging)"));

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) return i;
    }

    return cards.length;
  }

  private reorderInSection(column: KanbanColumn, movedPath: string, dropIndex: number): void {
    const cardsEl = this.sectionCardsEls.get(column);
    if (!cardsEl) return;

    // Get current order of paths in this section
    const currentPaths = Array.from(cardsEl.querySelectorAll<HTMLElement>(".task-card"))
      .map(el => el.dataset.path!)
      .filter(p => p !== movedPath);

    // Insert at drop position
    currentPaths.splice(dropIndex, 0, movedPath);

    // Save order
    this.taskOrder[column] = currentPaths;
    this.onOrderChange(this.taskOrder);

    // Re-render to apply
    this.render();
  }

  private reorderAfterMove(column: KanbanColumn, movedPath: string, dropIndex: number): void {
    const cardsEl = this.sectionCardsEls.get(column);
    if (!cardsEl) return;

    const currentPaths = Array.from(cardsEl.querySelectorAll<HTMLElement>(".task-card"))
      .map(el => el.dataset.path!);

    // Remove if already present (from default sort), then insert at desired position
    const filtered = currentPaths.filter(p => p !== movedPath);
    filtered.splice(Math.min(dropIndex, filtered.length), 0, movedPath);

    this.taskOrder[column] = filtered;
    this.onOrderChange(this.taskOrder);

    this.render();
  }

  private moveToTop(taskPath: string, column: KanbanColumn): void {
    const cardsEl = this.sectionCardsEls.get(column);
    if (!cardsEl) return;

    // Get current order of paths in this section
    const currentPaths = Array.from(cardsEl.querySelectorAll<HTMLElement>(".task-card"))
      .map(el => el.dataset.path!)
      .filter(p => p !== taskPath);

    // Insert at position 0
    currentPaths.unshift(taskPath);

    this.taskOrder[column] = currentPaths;
    this.onOrderChange(this.taskOrder);
    this.render();
  }

  private async contextMove(task: TaskFile, targetCol: KanbanColumn): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
    if (!file) return;
    await this.mover.moveTask(file, targetCol);
    setTimeout(() => this.render(), 200);
  }

  private async completeAndClose(task: TaskFile): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
    if (!file) return;
    await this.mover.moveTask(file, "done");
    this.onCloseSessions?.(task.path);
    setTimeout(() => this.render(), 200);
  }

  private async deleteTask(task: TaskFile): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
    if (!file) return;
    await this.app.vault.trash(file, true);
    // Vault "delete" event will trigger a refresh via the view's watcher
  }

  private async splitTask(task: TaskFile, column: KanbanColumn): Promise<void> {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`;

    // Build slug from original title (truncated kebab-case)
    const slug = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/, "");

    const filename = `TASK-${dateStr}-${timeStr}-split-from-${slug}.md`;
    const folder = `${this.parser.basePath}/${STATE_FOLDER_MAP[column]}`;
    const newPath = `${folder}/${filename}`;

    const title = `Split from: ${task.title}`;
    const isoNow = now.toISOString().replace(/\.\d{3}Z$/, "Z");

    // Strip the filename extension from original for wikilink
    const originalBasename = task.filename.replace(/\.md$/, "");

    const uuid = crypto.randomUUID();

    const content = [
      "---",
      `id: ${uuid}`,
      "tags:",
      "  - task",
      `  - task/${column === "done" ? "done" : column}`,
      "  - engineering",
      `state: ${column === "done" ? "done" : column}`,
      `title: "${title}"`,
      "source:",
      '  type: prompt',
      `  id: "split-${dateStr}T${timeStr}"`,
      '  url: ""',
      `  captured: ${isoNow}`,
      "priority:",
      "  score: 0",
      '  deadline: ""',
      "  impact: medium",
      "  has-blocker: false",
      '  blocker-context: ""',
      "agent-actionable: true",
      'agent-actionable-reason: "Split task - scope to be defined by user"',
      `goal: ${JSON.stringify(task.goal)}`,
      "related:",
      `  - "[[${originalBasename}]]"`,
      `created: ${isoNow}`,
      `updated: ${isoNow}`,
      "---",
      "",
      `# ${title}`,
      "",
      "## Context",
      `Split from [[${originalBasename}]]. Scope to be defined.`,
      "",
      "## Activity Log",
      `- **${now.toISOString().slice(0, 10)} ${pad(now.getHours())}:${pad(now.getMinutes())}** - Created as split from "${task.title}"`,
      "",
    ].join("\n");

    // Ensure folder exists
    const folderAbstract = this.app.vault.getAbstractFileByPath(folder);
    if (!folderAbstract) {
      await this.app.vault.createFolder(folder);
    }

    await this.app.vault.create(newPath, content);

    // Insert into custom order immediately after original task
    const order = this.taskOrder[column] || [];
    const origIdx = order.indexOf(task.path);
    if (origIdx !== -1) {
      order.splice(origIdx + 1, 0, newPath);
    } else {
      // Original wasn't in custom order - build order from current DOM and insert after
      const cardsEl = this.sectionCardsEls.get(column);
      if (cardsEl) {
        const currentPaths = Array.from(cardsEl.querySelectorAll<HTMLElement>(".task-card"))
          .map(el => el.dataset.path!);
        const domIdx = currentPaths.indexOf(task.path);
        currentPaths.splice(domIdx + 1, 0, newPath);
        this.taskOrder[column] = currentPaths;
      } else {
        order.push(newPath);
        this.taskOrder[column] = order;
      }
    }
    this.onOrderChange(this.taskOrder);

    // Wait for metadataCache to parse the new file, then re-render and select
    this.waitForMetadataCache(newPath, async () => {
      await this.render();
      this.selectTaskByPath(newPath);
      this.onSplitComplete?.(newPath, task.title);
    });
  }

  private copyName(task: TaskFile): void {
    navigator.clipboard.writeText(task.title);
  }

  private copyPath(task: TaskFile): void {
    const fullPath = this.resolveFullPath(task.path);
    navigator.clipboard.writeText(fullPath);
  }

  private copyPrompt(task: TaskFile): void {
    const fullPath = this.resolveFullPath(task.path);
    navigator.clipboard.writeText(buildContextPrompt(task, fullPath));
  }

  private resolveFullPath(vaultRelativePath: string): string {
    return this.vaultPath + "/" + vaultRelativePath;
  }

  private selectTask(task: TaskFile): void {
    if (this.selectedPath) {
      this.cards.get(this.selectedPath)?.setSelected(false);
    }
    this.selectedPath = task.path;
    this.cards.get(task.path)?.setSelected(true);
    this.onTaskSelect(task);
  }

  /** Programmatically select a task by its vault-relative path. Returns true if found. */
  selectTaskByPath(path: string): boolean {
    const card = this.cards.get(path);
    if (!card) return false;
    this.selectTask(card.getTask());
    return true;
  }

  setFilter(term: string): void {
    this.filterTerm = term.toLowerCase().trim();
    this.applyFilter();
  }

  private applyFilter(): void {
    for (const [col, cardsEl] of this.sectionCardsEls) {
      let visibleCount = 0;
      const section = this.sectionEls.get(col);

      for (const card of this.cards.values()) {
        if (!cardsEl.contains(card.el)) continue;

        if (!this.filterTerm || card.getTitle().toLowerCase().includes(this.filterTerm)) {
          card.el.style.display = "";
          visibleCount++;
        } else {
          card.el.style.display = "none";
        }
      }

      if (section) {
        if (this.filterTerm && visibleCount === 0) {
          section.style.display = "none";
        } else {
          section.style.display = "";
        }
      }
    }
  }

  rekeyTask(oldPath: string, newPath: string): void {
    if (this.selectedPath === oldPath) {
      this.selectedPath = newPath;
    }
  }

  async refreshCard(path: string): Promise<void> {
    await this.render();
  }

  getSelectedPath(): string | null {
    return this.selectedPath;
  }

  /**
   * Wait for metadataCache to have parsed frontmatter for a vault-relative path.
   * Uses a one-shot listener with a timeout fallback.
   */
  private waitForMetadataCache(path: string, callback: () => void): void {
    // Check if already cached
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) {
      const cache = this.app.metadataCache.getFileCache(file as any);
      if (cache?.frontmatter) {
        callback();
        return;
      }
    }

    let resolved = false;
    const resolve = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(fallback);
      this.app.metadataCache.off("changed", handler);
      callback();
    };

    const handler = (changedFile: any) => {
      if (changedFile.path === path) {
        const cache = this.app.metadataCache.getFileCache(changedFile);
        if (cache?.frontmatter) {
          resolve();
        }
      }
    };

    this.app.metadataCache.on("changed", handler);
    const fallback = setTimeout(resolve, 3000);
  }

  // --- Placeholder card management ---

  /** Add a placeholder card at the top of the "todo" column for an in-flight creation. */
  addPlaceholder(id: string, prompt: string, column: KanbanColumn = "todo"): void {
    const truncated = prompt.length > 50 ? prompt.slice(0, 47) + "..." : prompt;
    const el = document.createElement("div");
    el.addClass("task-card", "task-card-placeholder");
    el.innerHTML = `
      <div class="task-card-title-row">
        <div class="task-card-title placeholder-title">
          <span class="placeholder-spinner"></span>
          Creating task...
        </div>
      </div>
      <div class="task-card-meta">
        <span class="task-card-source placeholder-prompt" title="${prompt.replace(/"/g, "&quot;")}">${truncated}</span>
      </div>
    `;

    const placeholder: PendingPlaceholder = { id, prompt, column, el, state: "creating" };
    this.placeholders.set(id, placeholder);

    const cardsEl = this.sectionCardsEls.get(column);
    if (cardsEl) {
      cardsEl.prepend(el);
      this.updateSectionCount(column, 1);
    }
  }

  /** Mark a placeholder as done (will be removed on next render when real card appears). */
  resolvePlaceholder(id: string, summary: string): void {
    const placeholder = this.placeholders.get(id);
    if (!placeholder) return;
    placeholder.state = "done";
    const titleEl = placeholder.el.querySelector(".placeholder-title");
    if (titleEl) {
      titleEl.innerHTML = `<span class="placeholder-check">&#10003;</span> ${summary}`;
    }
    placeholder.el.addClass("placeholder-done");
    placeholder.el.removeClass("task-card-placeholder");
  }

  /** Mark a placeholder as failed with an error message. Auto-removes after 5s. */
  failPlaceholder(id: string, error: string): void {
    const placeholder = this.placeholders.get(id);
    if (!placeholder) return;
    placeholder.state = "error";
    const titleEl = placeholder.el.querySelector(".placeholder-title");
    if (titleEl) {
      const truncErr = error.length > 60 ? error.slice(0, 57) + "..." : error;
      titleEl.innerHTML = `<span class="placeholder-error-icon">&#10007;</span> Failed: ${truncErr}`;
      titleEl.setAttribute("title", error);
    }
    placeholder.el.addClass("placeholder-error");
    placeholder.el.removeClass("task-card-placeholder");

    setTimeout(() => this.removePlaceholder(id), 5000);
  }

  /** Remove a placeholder card from the DOM and tracking map. */
  removePlaceholder(id: string): void {
    const placeholder = this.placeholders.get(id);
    if (!placeholder) return;
    placeholder.el.remove();
    this.placeholders.delete(id);
    // Count will be corrected on next render
  }

  /** Mark a task path as currently being ingested by background Claude. */
  setIngesting(path: string): void {
    this.ingestingPaths.add(path);
    const card = this.cards.get(path);
    if (card) {
      card.el.addClass("ingesting");
      const meta = card.el.querySelector(".task-card-meta");
      if (meta && !meta.querySelector(".task-card-ingesting")) {
        const badge = document.createElement("span");
        badge.className = "task-card-ingesting";
        badge.textContent = "ingesting...";
        const source = meta.querySelector(".task-card-source");
        if (source?.nextSibling) {
          meta.insertBefore(badge, source.nextSibling);
        } else {
          meta.appendChild(badge);
        }
      }
    }
  }

  /** Clear ingesting status for a task path. */
  clearIngesting(path: string): void {
    this.ingestingPaths.delete(path);
    const card = this.cards.get(path);
    if (card) {
      card.el.removeClass("ingesting");
      card.el.querySelector(".task-card-ingesting")?.remove();
    }
  }

  private updateSectionCount(column: KanbanColumn, delta: number): void {
    const section = this.sectionEls.get(column);
    if (!section) return;
    const countEl = section.querySelector(".section-count");
    if (countEl) {
      const current = parseInt(countEl.textContent || "0", 10);
      countEl.textContent = String(current + delta);
    }
  }

  /** Update the Claude state CSS class on a task card.
   *  For idle state, sets a negative animation-delay so the staleness
   *  animation resumes at the correct position even after re-renders. */
  setClaudeState(taskPath: string, state: ClaudeState, idleSince?: number): void {
    const card = this.cards.get(taskPath);
    if (!card) return;

    const el = card.el;
    const targetClass = state === "waiting" ? "claude-waiting"
      : state === "idle" ? "claude-idle"
      : state === "active" ? "claude-active"
      : null;

    // Already has the correct class - no-op to preserve CSS animations
    if (targetClass && el.hasClass(targetClass)) {
      // Still update animation-delay for idle in case timestamp changed
      if (state === "idle" && idleSince) {
        this.applyIdleAnimationOffset(el, idleSince);
      }
      return;
    }

    el.removeClass("claude-active", "claude-idle", "claude-waiting");
    // Clear animation offset when leaving idle
    el.style.removeProperty("--idle-offset");
    if (targetClass) el.addClass(targetClass);

    // Set animation offset so staleness picks up where it left off
    if (state === "idle") {
      this.applyIdleAnimationOffset(el, idleSince);
    }
  }

  /** Set --idle-offset CSS variable for animation-delay fast-forward.
   *  When idleSince is undefined (e.g. plugin just loaded), defaults to
   *  fully stale (300s elapsed) so cards don't animate from fresh. */
  private applyIdleAnimationOffset(el: HTMLElement, idleSince?: number): void {
    const elapsedSec = idleSince ? (Date.now() - idleSince) / 1000 : 300;
    el.style.setProperty("--idle-offset", `-${elapsedSec.toFixed(1)}s`);
  }

  /** Update session badges on all cards in-place (no re-render). */
  updateSessionBadges(): void {
    for (const card of this.cards.values()) {
      card.updateSessionBadge();
    }
  }
}
