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

export class KanbanBoard {
  private cards: Map<string, TaskCard> = new Map();
  private selectedPath: string | null = null;
  private columnEls: Map<KanbanColumn, HTMLElement> = new Map();

  constructor(
    private containerEl: HTMLElement,
    private app: App,
    private parser: TaskParser,
    private mover: TaskMover,
    private onTaskSelect: (task: TaskFile | null) => void
  ) {}

  async render(): Promise<void> {
    this.containerEl.empty();
    this.cards.clear();
    this.columnEls.clear();

    const tasks = await this.parser.loadAllTasks();
    const groups = this.parser.groupByColumn(tasks);

    for (const col of KANBAN_COLUMNS) {
      const column = this.containerEl.createDiv({ cls: "kanban-column" });
      column.dataset.column = col;

      // Header
      const header = column.createDiv({ cls: "kanban-column-header" });
      header.createSpan({ text: COLUMN_LABELS[col] });
      header.createSpan({ cls: "count", text: String(groups[col].length) });

      // Cards container
      const cardsEl = column.createDiv({ cls: "kanban-column-cards" });
      this.columnEls.set(col, cardsEl);

      for (const task of groups[col]) {
        const card = new TaskCard(task, (t) => this.selectTask(t));
        this.cards.set(task.path, card);
        cardsEl.appendChild(card.el);
      }

      // Drop zone events
      this.setupDropZone(column, col);
    }
  }

  private setupDropZone(columnEl: HTMLElement, column: KanbanColumn): void {
    columnEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      columnEl.addClass("drag-over");
    });

    columnEl.addEventListener("dragenter", (e) => {
      e.preventDefault();
      columnEl.addClass("drag-over");
    });

    columnEl.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !columnEl.contains(related)) {
        columnEl.removeClass("drag-over");
      }
    });

    columnEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      columnEl.removeClass("drag-over");

      const taskPath = e.dataTransfer?.getData("text/plain");
      if (!taskPath) return;

      const file = this.app.vault.getAbstractFileByPath(taskPath) as TFile;
      if (!file) return;

      await this.mover.moveTask(file, column);
      // Re-render after a short delay to let vault events settle
      setTimeout(() => this.render(), 200);
    });
  }

  private selectTask(task: TaskFile): void {
    // Deselect previous
    if (this.selectedPath) {
      this.cards.get(this.selectedPath)?.setSelected(false);
    }

    this.selectedPath = task.path;
    this.cards.get(task.path)?.setSelected(true);
    this.onTaskSelect(task);
  }

  async refreshCard(path: string): Promise<void> {
    // Just re-render the whole board for simplicity
    // The debounce in TaskTerminalView prevents excess calls
    await this.render();

    // Restore selection
    if (this.selectedPath) {
      this.cards.get(this.selectedPath)?.setSelected(true);
    }
  }

  getSelectedPath(): string | null {
    return this.selectedPath;
  }
}
