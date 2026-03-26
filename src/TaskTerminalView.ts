import { ItemView, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_TASK_TERMINAL, STATE_FOLDER_MAP, type TaskTerminalSettings, type KanbanColumn } from "./types";
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
  /** Tracks recently deleted task paths that had terminal sessions, for delete+create rename detection. */
  private pendingRenames: Map<string, { uuid: string; timer: ReturnType<typeof setTimeout> }> = new Map();
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

    // Prompt box: creates the task file instantly, then enriches in background
    const promptContainer = topBar.createDiv({ cls: "prompt-box-container" });
    const promptBox = new PromptBox(promptContainer, this.plugin.settings);
    promptBox.onSubmit = (request) => {
      this.createTaskFile(request.prompt, request.column, promptBox);
    };

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
      (path) => this.terminalPanel.getSessionCounts(path),
      (newPath, originalTitle) => {
        // Auto-spawn a task agent for the newly split task with scoping prompt
        this.terminalPanel.spawnTaskAgent([
          "---",
          `This is a newly split task created from "${originalTitle}".`,
          "Ask the user what scope this split task should cover, then update the task file:",
          "- Rename the title to reflect the scoped work",
          "- Update the description/context with the agreed scope",
          "- Rename the file to match the new title (TASK-YYYYMMDD-HHMM-new-slug.md pattern)",
        ]);
      }
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
          // Check if this is the "create" half of a delete+create rename
          this.handlePossibleRename(file.path);

          // Prepend new tasks to the top of their column's custom order
          // so they appear first rather than being sorted to the bottom.
          const col = this.columnFromPath(file.path);
          if (col) {
            const order = this.plugin.taskOrder[col] || [];
            if (!order.includes(file.path)) {
              order.unshift(file.path);
              this.plugin.taskOrder[col] = order;
              this.plugin.saveTaskOrder();
            }
          }

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
          // If the deleted file had terminal sessions, buffer it for delete+create rename detection.
          // Shell-based renames (mv) appear as delete+create rather than a rename event.
          if (this.terminalPanel.hasSessions(file.path)) {
            // Grab UUID from metadata cache before it's cleared
            const cache = this.app.metadataCache.getCache(file.path);
            const uuid = cache?.frontmatter?.id || "";
            const timer = setTimeout(() => {
              this.pendingRenames.delete(file.path);
            }, 2000);
            this.pendingRenames.set(file.path, { uuid, timer });
          }
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

  /**
   * When a new task file is created, check if it matches a recently deleted task that had
   * terminal sessions. If so, treat it as a rename: re-key sessions, selection, and order.
   * This handles shell-based renames (mv) which Obsidian sees as delete+create.
   * Matches by UUID (frontmatter `id` field) when available, falls back to same-folder heuristic.
   */
  private handlePossibleRename(newPath: string): void {
    if (this.pendingRenames.size === 0) return;

    // Try to read the new file's UUID from the metadata cache
    const newCache = this.app.metadataCache.getCache(newPath);
    const newUuid = newCache?.frontmatter?.id || "";

    let matchedOldPath: string | null = null;

    // First pass: match by UUID (confident match, works across folders)
    if (newUuid) {
      for (const [oldPath, entry] of this.pendingRenames) {
        if (entry.uuid && entry.uuid === newUuid) {
          matchedOldPath = oldPath;
          break;
        }
      }
    }

    // Second pass: fall back to same-folder heuristic for tasks without UUIDs
    if (!matchedOldPath) {
      const newFolder = newPath.substring(0, newPath.lastIndexOf("/"));
      for (const [oldPath, entry] of this.pendingRenames) {
        if (!entry.uuid) {
          const oldFolder = oldPath.substring(0, oldPath.lastIndexOf("/"));
          if (oldFolder === newFolder) {
            matchedOldPath = oldPath;
            break;
          }
        }
      }
    }

    if (!matchedOldPath) return;

    const entry = this.pendingRenames.get(matchedOldPath)!;
    clearTimeout(entry.timer);
    this.pendingRenames.delete(matchedOldPath);

    console.log(`[task-terminal] Detected rename via delete+create: ${matchedOldPath} -> ${newPath}` +
      (newUuid ? ` (matched by UUID ${newUuid})` : " (matched by folder)"));

    this.terminalPanel.rekeyTask(matchedOldPath, newPath);
    this.taskList.rekeyTask(matchedOldPath, newPath);

    // Update stored task order
    let orderChanged = false;
    for (const col of Object.keys(this.plugin.taskOrder)) {
      const paths = this.plugin.taskOrder[col];
      const idx = paths.indexOf(matchedOldPath);
      if (idx !== -1) {
        paths[idx] = newPath;
        orderChanged = true;
      }
    }
    if (orderChanged) {
      this.plugin.saveTaskOrder();
    }
  }

  /** Infer the kanban column from a task file's folder path. */
  private columnFromPath(path: string): KanbanColumn | null {
    const base = this.plugin.settings.taskBasePath + "/";
    if (!path.startsWith(base)) return null;
    const rest = path.slice(base.length);
    const folder = rest.split("/")[0];
    // STATE_FOLDER_MAP maps column -> folder; invert it
    for (const [col, f] of Object.entries(STATE_FOLDER_MAP)) {
      if (f === folder) return col as KanbanColumn;
    }
    return null;
  }

  /**
   * Create a task file instantly from the prompt, then spawn Claude in the background to enrich it.
   * The task appears immediately in the kanban board; enrichment updates it in place.
   */
  private async createTaskFile(prompt: string, column: KanbanColumn, promptBox: PromptBox): Promise<void> {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`;

    // Derive a title from the prompt (first sentence or first 60 chars)
    const rawTitle = prompt.split(/[.\n]/)[0].trim();
    const title = rawTitle.length > 60 ? rawTitle.slice(0, 57) + "..." : rawTitle;

    // Build slug from title
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/, "");

    const filename = `TASK-${dateStr}-${timeStr}-${slug}.md`;
    const folder = `${this.plugin.settings.taskBasePath}/${STATE_FOLDER_MAP[column]}`;
    const newPath = `${folder}/${filename}`;
    const isoNow = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const uuid = crypto.randomUUID();
    const state = column === "done" ? "done" : column;

    const content = [
      "---",
      `id: ${uuid}`,
      "tags:",
      "  - task",
      `  - task/${state}`,
      "  - engineering",
      `state: ${state}`,
      `title: "${title.replace(/"/g, '\\"')}"`,
      "source:",
      "  type: prompt",
      `  id: "prompt-${dateStr}T${timeStr}"`,
      '  url: ""',
      `  captured: ${isoNow}`,
      "priority:",
      "  score: 0",
      '  deadline: ""',
      "  impact: medium",
      "  has-blocker: false",
      '  blocker-context: ""',
      "agent-actionable: true",
      'agent-actionable-reason: "Created from task-terminal prompt"',
      "goal: []",
      "related: []",
      `created: ${isoNow}`,
      `updated: ${isoNow}`,
      "---",
      "",
      `# ${title}`,
      "",
      "## Context",
      prompt,
      "",
      "## Source",
      prompt,
      "",
      "## Enrichment Notes",
      "",
      "",
      "## Next Steps",
      "- [ ] Run duplicate check (deferred from fast creation)",
      "- [ ] Run goal alignment (deferred from fast creation)",
      "- [ ] Run related task detection (deferred from fast creation)",
      "",
      "## Activity Log",
      `- **${now.toISOString().slice(0, 10)} ${pad(now.getHours())}:${pad(now.getMinutes())}** - Created from prompt (fast mode)`,
      "",
    ].join("\n");

    // Ensure folder exists
    const folderAbstract = this.app.vault.getAbstractFileByPath(folder);
    if (!folderAbstract) {
      await this.app.vault.createFolder(folder);
    }

    await this.app.vault.create(newPath, content);

    // Prepend to custom order so it appears at the top
    const order = this.plugin.taskOrder[column] || [];
    if (!order.includes(newPath)) {
      order.unshift(newPath);
      this.plugin.taskOrder[column] = order;
      this.plugin.saveTaskOrder();
    }

    console.log(`[task-terminal] Task file created: ${newPath}`);

    // Spawn Claude in background to enrich (non-blocking, fire and forget)
    const adapter = this.app.vault.adapter as any;
    let vaultPath: string = adapter.basePath || adapter.getBasePath?.() || "";
    const home = process.env.HOME || "";
    if (vaultPath.startsWith("~/") || vaultPath === "~") {
      vaultPath = home + vaultPath.slice(1);
    } else if (!vaultPath.startsWith("/") && home) {
      vaultPath = home + "/" + vaultPath;
    }
    const fullPath = vaultPath + "/" + newPath;

    this.taskList.setIngesting(newPath);
    promptBox.runBackgroundEnrich(fullPath).then(
      () => this.taskList.clearIngesting(newPath),
      (err) => {
        console.error(`[task-terminal] Background enrich failed for ${newPath}:`, err);
        this.taskList.clearIngesting(newPath);
      }
    );
  }

  /**
   * Wait for a task file (by filename) to appear in metadataCache with parsed frontmatter.
   * Listens for metadataCache "changed" events and falls back to a timeout.
   */
  private waitForTaskFile(filename: string, callback: () => void): void {
    // Check if it already exists
    const existing = this.app.vault.getMarkdownFiles().find((f) => f.name === filename);
    if (existing) {
      const cache = this.app.metadataCache.getFileCache(existing);
      if (cache?.frontmatter?.state) {
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

    const handler = (file: any) => {
      if (file.name === filename) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter?.state) {
          resolve();
        }
      }
    };

    this.app.metadataCache.on("changed", handler);

    // Fallback: if metadataCache never fires, resolve after 5s
    const fallback = setTimeout(resolve, 5000);
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
    for (const entry of this.pendingRenames.values()) clearTimeout(entry.timer);
    this.pendingRenames.clear();
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
