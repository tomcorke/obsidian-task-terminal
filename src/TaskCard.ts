import type { TaskFile, KanbanColumn } from "./types";
import { KANBAN_COLUMNS, COLUMN_LABELS } from "./types";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const SOURCE_LABELS: Record<string, string> = {
  jira: "JIRA",
  slack: "SLK",
  confluence: "CONF",
  prompt: "CLI",
  other: "---",
};

export class TaskCard {
  el: HTMLElement;
  private sessionBadge: HTMLElement | null = null;

  constructor(
    private task: TaskFile,
    private column: KanbanColumn,
    private onSelect: (task: TaskFile) => void,
    private onMoveToTop?: (task: TaskFile) => void,
    private getSessionCount?: (path: string) => { shells: number; claudes: number },
    private onContextMove?: (task: TaskFile, column: KanbanColumn) => void,
    private onCopyName?: (task: TaskFile) => void,
    private onCopyPath?: (task: TaskFile) => void,
    private onCopyPrompt?: (task: TaskFile) => void,
    private onSplitTask?: (task: TaskFile) => void,
    private onDeleteTask?: (task: TaskFile) => void,
    private ingesting?: boolean
  ) {
    this.el = this.render();
  }

  private render(): HTMLElement {
    const card = document.createElement("div");
    card.addClass("task-card");
    if (this.ingesting) card.addClass("ingesting");
    card.dataset.path = this.task.path;
    card.draggable = true;

    // Title row
    const titleRow = card.createDiv({ cls: "task-card-title-row" });
    const title = titleRow.createDiv({ cls: "task-card-title" });
    title.textContent = this.task.title;

    // Move-to-top button (visible on hover)
    if (this.onMoveToTop) {
      const moveBtn = titleRow.createDiv({ cls: "task-card-move-top", attr: { title: "Move to top" } });
      moveBtn.textContent = "\u2191";
      moveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onMoveToTop?.(this.task);
        this.onSelect(this.task);
      });
    }

    // Session count badge (top-right circle)
    if (this.getSessionCount) {
      const counts = this.getSessionCount(this.task.path);
      const total = counts.shells + counts.claudes;
      if (total > 0) {
        const badge = titleRow.createDiv({ cls: "task-card-session-badge" });
        badge.textContent = String(total);
        badge.title = `${counts.claudes} Claude, ${counts.shells} Shell`;
        if (counts.claudes > 0 && counts.shells === 0) {
          badge.addClass("badge-claude");
        } else if (counts.shells > 0 && counts.claudes === 0) {
          badge.addClass("badge-shell");
        } else {
          badge.addClass("badge-mixed");
        }
        this.sessionBadge = badge;
      }
    }

    // Meta row
    const meta = card.createDiv({ cls: "task-card-meta" });

    // Source badge
    const source = meta.createSpan({ cls: "task-card-source" });
    source.textContent = SOURCE_LABELS[this.task.source.type] || "---";

    // Ingesting indicator
    if (this.ingesting) {
      const badge = meta.createSpan({ cls: "task-card-ingesting" });
      badge.textContent = "ingesting...";
    }

    // Priority score
    if (this.task.priority.score > 0) {
      const score = meta.createSpan({ cls: "task-card-score" });
      score.textContent = String(this.task.priority.score);
      if (this.task.priority.score >= 60) {
        score.addClass("score-high");
      } else if (this.task.priority.score >= 30) {
        score.addClass("score-medium");
      } else {
        score.addClass("score-low");
      }
    }

    // Goal tags
    for (const g of this.task.goal.slice(0, 2)) {
      const goalEl = meta.createSpan({ cls: "task-card-goal" });
      goalEl.textContent = g.replace(/-/g, " ");
      goalEl.title = g;
    }

    // Blocker indicator
    if (this.task.priority["has-blocker"]) {
      const blocker = meta.createSpan({ cls: "task-card-source" });
      blocker.textContent = "BLOCKED";
      blocker.style.background = "#e5484d";
      blocker.style.color = "white";
      if (this.task.priority["blocker-context"]) {
        blocker.title = this.task.priority["blocker-context"];
      }
    }

    // Click to select
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onSelect(this.task);
    });

    // Right-click context menu
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showContextMenu(e.clientX, e.clientY);
    });

    // Drag events
    card.addEventListener("dragstart", (e) => {
      card.addClass("dragging");
      e.dataTransfer?.setData("text/plain", this.task.path);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
      }
    });

    card.addEventListener("dragend", () => {
      card.removeClass("dragging");
    });

    return card;
  }

  private showContextMenu(x: number, y: number): void {
    const items: MenuItem[] = [];

    // Move to top
    items.push({
      label: "Move to Top",
      action: () => this.onMoveToTop?.(this.task),
    });

    // Split task
    items.push({
      label: "Split Task",
      action: () => this.onSplitTask?.(this.task),
    });

    items.push({ separator: true });

    // Move to other columns
    for (const col of KANBAN_COLUMNS) {
      if (col === this.column) continue;
      items.push({
        label: `Move to ${COLUMN_LABELS[col]}`,
        action: () => this.onContextMove?.(this.task, col),
      });
    }

    items.push({ separator: true });

    // Copy actions
    items.push({
      label: "Copy Name",
      action: () => this.onCopyName?.(this.task),
    });
    items.push({
      label: "Copy Path",
      action: () => this.onCopyPath?.(this.task),
    });
    items.push({
      label: "Copy Context Prompt",
      action: () => this.onCopyPrompt?.(this.task),
    });

    items.push({ separator: true });

    items.push({
      label: "Delete Task",
      danger: true,
      action: () => this.onDeleteTask?.(this.task),
    });

    new ContextMenu(items, x, y);
  }

  setSelected(selected: boolean): void {
    if (selected) {
      this.el.addClass("selected");
    } else {
      this.el.removeClass("selected");
    }
  }

  getPath(): string {
    return this.task.path;
  }

  getTask(): TaskFile {
    return this.task;
  }

  getTitle(): string {
    return this.task.title;
  }
}
