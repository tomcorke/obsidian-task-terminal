import { ItemView, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_TASK_TERMINAL, type TaskTerminalSettings } from "./types";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { KanbanBoard } from "./KanbanBoard";
import { TerminalPanel } from "./TerminalPanel";
import type TaskTerminalPlugin from "./main";

export class TaskTerminalView extends ItemView {
  private kanban: KanbanBoard;
  private terminalPanel: TerminalPanel;
  private parser: TaskParser;
  private mover: TaskMover;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TaskTerminalPlugin) {
    super(leaf);

    const settings = plugin.settings;
    this.parser = new TaskParser(this.app, settings.taskBasePath);
    this.mover = new TaskMover(this.app, settings.taskBasePath);

    // These get initialized in onOpen
    this.kanban = null!;
    this.terminalPanel = null!;
  }

  getViewType(): string {
    return VIEW_TYPE_TASK_TERMINAL;
  }

  getDisplayText(): string {
    return "Task Terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("task-terminal-container");

    // Left panel - kanban
    const kanbanEl = container.createDiv({ cls: "task-terminal-kanban" });

    // Resize divider
    const divider = container.createDiv({ cls: "task-terminal-divider" });
    this.setupResizer(divider, kanbanEl);

    // Right panel - terminals
    const terminalsEl = container.createDiv({ cls: "task-terminal-terminals" });

    // Resolve vault path for terminal CWD - expand ~ to home dir
    const adapter = this.app.vault.adapter as any;
    let vaultPath: string = adapter.basePath || adapter.getBasePath?.() || "";
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (vaultPath.startsWith("~/") || vaultPath === "~") {
      vaultPath = home + vaultPath.slice(1);
    } else if (!vaultPath.startsWith("/") && home) {
      // Relative path - resolve against home
      vaultPath = home + "/" + vaultPath;
    }
    console.log("[task-terminal] Resolved vault path:", vaultPath);

    // Initialize components
    this.terminalPanel = new TerminalPanel(
      terminalsEl,
      this.plugin.settings,
      vaultPath
    );

    this.kanban = new KanbanBoard(
      kanbanEl,
      this.app,
      this.parser,
      this.mover,
      (task) => this.terminalPanel.setTask(task)
    );

    await this.kanban.render();

    // Register vault events for live sync
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.parser.isTaskFile(file.path)) {
          this.debouncedRefresh();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.parser.isTaskFile(file.path)) {
          this.debouncedRefresh();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.parser.isTaskFile(file.path)) {
          this.debouncedRefresh();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (
          this.parser.isTaskFile(file.path) ||
          this.parser.isTaskFile(oldPath)
        ) {
          this.debouncedRefresh();
        }
      })
    );
  }

  private debouncedRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.kanban.render();
    }, 150);
  }

  private setupResizer(divider: HTMLElement, leftPanel: HTMLElement): void {
    let startX: number;
    let startWidth: number;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(250, Math.min(startWidth + delta, window.innerWidth - 350));
      leftPanel.style.flexBasis = `${newWidth}px`;
    };

    const onMouseUp = () => {
      divider.removeClass("dragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = leftPanel.getBoundingClientRect().width;
      divider.addClass("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.terminalPanel?.disposeAll();
  }
}
