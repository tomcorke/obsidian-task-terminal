import type { App, TFile } from "obsidian";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { TaskCard } from "./TaskCard";
import {
  type TaskFile,
  type KanbanColumn,
  KANBAN_COLUMNS,
  COLUMN_LABELS,
} from "./types";

export class TaskListPanel {
  private cards: Map<string, TaskCard> = new Map();
  private selectedPath: string | null = null;
  private sectionEls: Map<KanbanColumn, HTMLElement> = new Map();
  private sectionCardsEls: Map<KanbanColumn, HTMLElement> = new Map();
  private collapsedSections: Set<KanbanColumn> = new Set(["done"]);
  private filterTerm = "";
  private dragOverSection: KanbanColumn | null = null;

  constructor(
    private containerEl: HTMLElement,
    private app: App,
    private parser: TaskParser,
    private mover: TaskMover,
    private onTaskSelect: (task: TaskFile | null) => void
  ) {
    this.containerEl.addClass("task-list-panel");
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

      for (const task of groups[col]) {
        const card = new TaskCard(task, (t) => this.selectTask(t));
        this.cards.set(task.path, card);
        cardsEl.appendChild(card.el);
      }

      // Drop zone
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
    sectionEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

      // Auto-expand collapsed section on drag over
      if (this.collapsedSections.has(column)) {
        this.collapsedSections.delete(column);
        sectionEl.removeClass("collapsed");
      }

      if (this.dragOverSection !== column) {
        // Remove previous highlight
        if (this.dragOverSection) {
          this.sectionEls.get(this.dragOverSection)?.removeClass("drag-over");
        }
        this.dragOverSection = column;
        sectionEl.addClass("drag-over");
      }
    });

    sectionEl.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !sectionEl.contains(related)) {
        sectionEl.removeClass("drag-over");
        if (this.dragOverSection === column) {
          this.dragOverSection = null;
        }
      }
    });

    sectionEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      sectionEl.removeClass("drag-over");
      this.dragOverSection = null;

      const taskPath = e.dataTransfer?.getData("text/plain");
      if (!taskPath) return;

      const file = this.app.vault.getAbstractFileByPath(taskPath) as TFile;
      if (!file) return;

      // Check if card is already in this section
      const card = this.cards.get(taskPath);
      if (card) {
        const currentSection = card.el.closest(".task-list-section");
        if (currentSection?.dataset.section === column) return;
      }

      await this.mover.moveTask(file, column);
      setTimeout(() => this.render(), 200);
    });
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

      // Hide entire section if no visible cards (unless no filter active)
      if (section) {
        if (this.filterTerm && visibleCount === 0) {
          section.style.display = "none";
        } else {
          section.style.display = "";
        }
      }
    }
  }

  async refreshCard(path: string): Promise<void> {
    await this.render();
  }

  getSelectedPath(): string | null {
    return this.selectedPath;
  }
}
