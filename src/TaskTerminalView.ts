import { ItemView, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_TASK_TERMINAL, type TaskTerminalSettings } from "./types";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { TaskListPanel } from "./TaskListPanel";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { PromptBox } from "./PromptBox";
import { TerminalPanel } from "./TerminalPanel";
import type TaskTerminalPlugin from "./main";

export class TaskTerminalView extends ItemView {
  private taskList: TaskListPanel;
  private taskDetail: TaskDetailPanel;
  private terminalPanel: TerminalPanel;
  private parser: TaskParser;
  private mover: TaskMover;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private containerObserver: ResizeObserver | null = null;
  _isReloading = false;

  constructor(leaf: WorkspaceLeaf, private plugin: TaskTerminalPlugin) {
    super(leaf);

    const settings = plugin.settings;
    this.parser = new TaskParser(this.app, settings.taskBasePath);
    this.mover = new TaskMover(this.app, settings.taskBasePath);

    // Initialized in onOpen
    this.taskList = null!;
    this.taskDetail = null!;
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

    // === LEFT PANEL (task list + prompt + filter) ===
    const leftPanel = container.createDiv({ cls: "task-terminal-left-panel" });

    // Top bar: prompt box + filter
    const topBar = leftPanel.createDiv({ cls: "task-terminal-top-bar" });

    // Prompt box
    const promptContainer = topBar.createDiv({ cls: "prompt-box-container" });
    new PromptBox(promptContainer, this.plugin.settings);

    // Filter input
    const filterWrap = topBar.createDiv({ cls: "task-filter-wrap" });
    const filterInput = filterWrap.createEl("input", {
      cls: "task-filter-input",
      attr: { type: "text", placeholder: "Filter tasks..." },
    });
    filterInput.addEventListener("input", () => {
      if (this.filterTimer) clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.taskList.setFilter(filterInput.value);
      }, 100);
    });

    // Task list
    const taskListEl = leftPanel.createDiv({ cls: "task-list-container" });

    // === DIVIDER ===
    const divider = container.createDiv({ cls: "task-terminal-divider" });

    // === RIGHT PANEL (terminals) ===
    const rightPanel = container.createDiv({ cls: "task-terminal-right-panel" });

    // Resolve vault path
    const adapter = this.app.vault.adapter as any;
    let vaultPath: string = adapter.basePath || adapter.getBasePath?.() || "";
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (vaultPath.startsWith("~/") || vaultPath === "~") {
      vaultPath = home + vaultPath.slice(1);
    } else if (!vaultPath.startsWith("/") && home) {
      vaultPath = home + "/" + vaultPath;
    }

    // Initialize components
    this.terminalPanel = new TerminalPanel(rightPanel, this.plugin.settings, vaultPath);
    this.terminalPanel.onSessionChange = () => this.taskList?.render();

    // TaskDetailPanel manages a separate workspace leaf for the editor
    // We pass a placeholder container for when no task is selected
    const detailPlaceholder = leftPanel.createDiv({ cls: "task-detail-placeholder-inline" });
    this.taskDetail = new TaskDetailPanel(detailPlaceholder, this.app, this.leaf);

    this.taskList = new TaskListPanel(
      taskListEl,
      this.app,
      this.parser,
      this.mover,
      this.plugin.taskOrder,
      vaultPath,
      (task) => {
        this.taskDetail.setTask(task);
        this.terminalPanel.setTask(task);
      },
      (order) => {
        this.plugin.taskOrder = order;
        this.plugin.saveTaskOrder();
      },
      (path) => this.terminalPanel.getSessionCounts(path)
    );

    await this.taskList.render();

    // Restore previously active task after reload
    const recoveredPath = this.terminalPanel.getRecoveredTaskPath();
    if (recoveredPath) {
      this.taskList.selectTaskByPath(recoveredPath);
    }

    // Setup resizer
    this.setupResizer(divider, leftPanel, 200);

    // Re-fit terminals when the overall pane resizes (e.g. switching back to this view)
    this.containerObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => this.terminalPanel.refitActive());
    });
    this.containerObserver.observe(container);

    // Vault events
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.parser.isTaskFile(file.path)) {
          this.debouncedRefresh(file.path);
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

    // MetadataCache fires "changed" after frontmatter is parsed, which may
    // be after the vault "create" event.  Without this, newly created tasks
    // don't appear because parseFromFrontmatter returns null on first render.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
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
        if (this.parser.isTaskFile(file.path) || this.parser.isTaskFile(oldPath)) {
          // Re-key terminal sessions and selection so they follow the moved/renamed task
          this.terminalPanel.rekeyTask(oldPath, file.path);
          this.taskList.rekeyTask(oldPath, file.path);

          // Update stored task order so the renamed file keeps its position
          let orderChanged = false;
          for (const col of Object.keys(this.plugin.taskOrder)) {
            const paths = this.plugin.taskOrder[col];
            const idx = paths.indexOf(oldPath);
            if (idx !== -1) {
              paths[idx] = file.path;
              orderChanged = true;
            }
          }
          if (orderChanged) {
            this.plugin.saveTaskOrder();
          }
          this.debouncedRefresh();
        }
      })
    );
  }

  private debouncedRefresh(modifiedPath?: string): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(async () => {
      await this.taskList.render();
      // Editor leaf auto-refreshes, no need to manually refresh detail
    }, 150);
  }

  private setupResizer(
    divider: HTMLElement,
    targetPanel: HTMLElement,
    minWidth: number
  ): void {
    let startX: number;
    let startWidth: number;
    const minRightWidth = 300;
    const dividerWidth = 5;

    const onMouseMove = (e: MouseEvent) => {
      const containerWidth = targetPanel.parentElement?.getBoundingClientRect().width || 0;
      const maxWidth = containerWidth - minRightWidth - dividerWidth;
      const delta = e.clientX - startX;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
      targetPanel.style.flexBasis = `${newWidth}px`;
      targetPanel.style.flexGrow = "0";
      targetPanel.style.flexShrink = "0";
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
      startWidth = targetPanel.getBoundingClientRect().width;
      divider.addClass("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  /** Stash terminal sessions for a soft reload (keeps processes alive). */
  prepareReload(): void {
    this._isReloading = true;
    this.terminalPanel?.stashAll();
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.containerObserver?.disconnect();
    this.taskDetail?.unload();
    if (this._isReloading) {
      // Sessions already stashed - don't kill processes
      console.log("[task-terminal] Reload: skipping terminal disposal");
    } else {
      this.terminalPanel?.disposeAll();
    }
  }
}
