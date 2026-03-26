import type { TaskFile } from "./types";

const SOURCE_LABELS: Record<string, string> = {
  jira: "JIRA",
  slack: "SLK",
  confluence: "CONF",
  prompt: "CLI",
  other: "---",
};

export class TaskCard {
  el: HTMLElement;

  constructor(
    private task: TaskFile,
    private onSelect: (task: TaskFile) => void
  ) {
    this.el = this.render();
  }

  private render(): HTMLElement {
    const card = document.createElement("div");
    card.addClass("task-card");
    card.dataset.path = this.task.path;
    card.draggable = true;

    // Title
    const title = card.createDiv({ cls: "task-card-title" });
    title.textContent = this.task.title;

    // Meta row
    const meta = card.createDiv({ cls: "task-card-meta" });

    // Source badge
    const source = meta.createSpan({ cls: "task-card-source" });
    source.textContent = SOURCE_LABELS[this.task.source.type] || "---";

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

    // Agent-actionable badge
    if (this.task.agentActionable) {
      const badge = meta.createSpan({ cls: "agent-badge" });
      badge.textContent = "AI";
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
}
