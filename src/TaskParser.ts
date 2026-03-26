import { type App, type TFile, parseYaml } from "obsidian";
import {
  type TaskFile,
  type TaskState,
  type KanbanColumn,
  KANBAN_COLUMNS,
  STATE_FOLDER_MAP,
} from "./types";

const VALID_STATES: TaskState[] = [
  "priority",
  "todo",
  "active",
  "done",
  "abandoned",
];

export class TaskParser {
  constructor(
    private app: App,
    readonly basePath: string
  ) {}

  parseFromFrontmatter(file: TFile): TaskFile | null {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) return null;

    const state = fm.state as TaskState;
    if (!VALID_STATES.includes(state)) return null;

    const source = fm.source || {};
    const priority = fm.priority || {};
    const tags: string[] = fm.tags || [];
    const goal: string[] = Array.isArray(fm.goal)
      ? fm.goal
      : fm.goal
        ? [fm.goal]
        : [];

    return {
      id: fm.id || "",
      path: file.path,
      filename: file.name,
      state,
      title: fm.title || file.basename,
      tags,
      source: {
        type: source.type || "other",
        id: source.id || "",
        url: source.url || "",
        captured: source.captured || "",
      },
      priority: {
        score: priority.score ?? 0,
        deadline: priority.deadline || "",
        impact: priority.impact || "medium",
        "has-blocker": priority["has-blocker"] ?? false,
        "blocker-context": priority["blocker-context"] || "",
      },
      agentActionable: fm["agent-actionable"] ?? false,
      goal,
      created: fm.created || "",
      updated: fm.updated || "",
    };
  }

  async loadAllTasks(): Promise<TaskFile[]> {
    const tasks: TaskFile[] = [];
    const folders = ["priority", "todo", "active", "archive"];

    for (const folder of folders) {
      const folderPath = `${this.basePath}/${folder}`;
      const abstractFile = this.app.vault.getAbstractFileByPath(folderPath);
      if (!abstractFile) continue;

      const files = this.app.vault.getMarkdownFiles().filter(
        (f) => f.path.startsWith(folderPath + "/") && f.extension === "md"
      );

      for (const file of files) {
        const task = this.parseFromFrontmatter(file);
        if (task) tasks.push(task);
      }
    }

    return tasks;
  }

  groupByColumn(tasks: TaskFile[]): Record<KanbanColumn, TaskFile[]> {
    const groups: Record<KanbanColumn, TaskFile[]> = {
      priority: [],
      todo: [],
      active: [],
      done: [],
    };

    for (const task of tasks) {
      if (task.state === "abandoned") continue;

      const column = task.state === "done" ? "done" : task.state;
      if (KANBAN_COLUMNS.includes(column as KanbanColumn)) {
        groups[column as KanbanColumn].push(task);
      }
    }

    // Sort each column: score desc, then updated desc
    for (const col of KANBAN_COLUMNS) {
      groups[col].sort((a, b) => {
        const scoreDiff = b.priority.score - a.priority.score;
        if (scoreDiff !== 0) return scoreDiff;
        return (b.updated || "").localeCompare(a.updated || "");
      });
    }

    return groups;
  }

  /** Add a UUID to any task file that doesn't have one. */
  async backfillIds(): Promise<number> {
    let count = 0;
    const tasks = await this.loadAllTasks();
    for (const task of tasks) {
      if (task.id) continue;
      const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
      if (!file) continue;

      const content = await this.app.vault.read(file);
      const uuid = crypto.randomUUID();

      // Insert id: after the opening ---
      const updated = content.replace(
        /^---\n/,
        `---\nid: ${uuid}\n`
      );
      if (updated !== content) {
        await this.app.vault.modify(file, updated);
        count++;
      }
    }
    return count;
  }

  isTaskFile(path: string): boolean {
    return (
      path.startsWith(this.basePath + "/") &&
      path.endsWith(".md")
    );
  }
}
