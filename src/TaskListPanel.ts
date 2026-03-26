import type { App, TFile } from "obsidian";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { TaskCard } from "./TaskCard";
import {
  type TaskFile,
  type KanbanColumn,
  KANBAN_COLUMNS,
  COLUMN_LABELS,
  STATE_FOLDER_MAP,
} from "./types";
import type { TaskOrder } from "./main";

export class TaskListPanel {
  private cards: Map<string, TaskCard> = new Map();
  private selectedPath: string | null = null;
  private sectionEls: Map<KanbanColumn, HTMLElement> = new Map();
  private sectionCardsEls: Map<KanbanColumn, HTMLElement> = new Map();
  private collapsedSections: Set<KanbanColumn> = new Set(["done"]);
  private filterTerm = "";
  private dragSourcePath: string | null = null;
  private dropIndicator: HTMLElement;

  constructor(
    private containerEl: HTMLElement,
    private app: App,
    private parser: TaskParser,
    private mover: TaskMover,
    private taskOrder: TaskOrder,
    private onTaskSelect: (task: TaskFile | null) => void,
    private onOrderChange: (order: TaskOrder) => void
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
          (t) => this.selectTask(t),
          (t) => this.moveToTop(t.path, col)
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

  private selectTask(task: TaskFile): void {
    if (this.selectedPath) {
      this.cards.get(this.selectedPath)?.setSelected(false);
    }
    this.selectedPath = task.path;
    this.cards.get(task.path)?.setSelected(true);
    this.onTaskSelect(task);
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
}
