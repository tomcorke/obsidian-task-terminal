import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { ChildProcess } from "child_process";

/**
 * State extracted from a TerminalTab that can survive a plugin reload.
 * Stored on `window.__taskTerminalStore` which persists across module re-evaluations.
 */
export interface StoredSession {
  id: string;
  taskPath: string | null;
  label: string;
  claudeSessionId: string | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  containerEl: HTMLElement;
  process: ChildProcess | null;
  documentListeners: { event: string; handler: EventListener }[];
  resizeObserver: ResizeObserver;
}

/**
 * Lightweight metadata persisted to disk so Claude sessions can be resumed
 * after a full plugin close/restart (not just hot-reload).
 */
export interface PersistedSession {
  taskPath: string;
  claudeSessionId: string;
  label: string;
  savedAt: string; // ISO timestamp
}

export interface StoredState {
  sessions: Map<string, StoredSession[]>;
  activeTaskPath: string | null;
  activeTabIndex: number;
}

declare global {
  interface Window {
    __taskTerminalStore?: StoredState;
  }
}

export class SessionStore {
  static stash(
    sessions: Map<string, StoredSession[]>,
    activeTaskPath: string | null,
    activeTabIndex: number
  ): void {
    window.__taskTerminalStore = { sessions, activeTaskPath, activeTabIndex };
    console.log("[task-terminal] Stashed", sessions.size, "task groups for reload");
  }

  static retrieve(): StoredState | null {
    const store = window.__taskTerminalStore;
    if (!store) return null;
    delete window.__taskTerminalStore;
    console.log("[task-terminal] Retrieved", store.sessions.size, "task groups from store");
    return store;
  }

  static isReload(): boolean {
    return !!window.__taskTerminalStore;
  }

  /**
   * Save Claude session metadata to disk via Obsidian's plugin data API.
   * Merges into existing plugin data (settings, taskOrder) under "persistedSessions" key.
   */
  static async saveToDisk(
    plugin: { loadData(): Promise<any>; saveData(data: any): Promise<void> },
    sessions: Map<string, { session: { label: string; taskPath: string | null }; claudeSessionId: string | null; isClaudeSession: boolean }[]>
  ): Promise<void> {
    const persisted: PersistedSession[] = [];
    for (const [taskPath, tabs] of sessions) {
      for (const tab of tabs) {
        if (tab.isClaudeSession && tab.claudeSessionId) {
          persisted.push({
            taskPath,
            claudeSessionId: tab.claudeSessionId,
            label: tab.session.label,
            savedAt: new Date().toISOString(),
          });
        }
      }
    }

    const data = (await plugin.loadData()) || {};
    data.persistedSessions = persisted;
    await plugin.saveData(data);
    console.log("[task-terminal] Saved", persisted.length, "Claude sessions to disk");
  }

  /**
   * Load persisted Claude session metadata from disk.
   * Filters out sessions older than 7 days (Claude's default retention).
   */
  static async loadFromDisk(
    plugin: { loadData(): Promise<any> }
  ): Promise<PersistedSession[]> {
    const data = (await plugin.loadData()) || {};
    const raw: PersistedSession[] = data.persistedSessions || [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const valid = raw.filter(s => new Date(s.savedAt).getTime() > cutoff);
    if (valid.length !== raw.length) {
      console.log("[task-terminal] Pruned", raw.length - valid.length, "stale persisted sessions");
    }
    return valid;
  }

  /**
   * Clear persisted sessions from disk (e.g. after all have been resumed or are stale).
   */
  static async clearPersistedFromDisk(
    plugin: { loadData(): Promise<any>; saveData(data: any): Promise<void> }
  ): Promise<void> {
    const data = (await plugin.loadData()) || {};
    delete data.persistedSessions;
    await plugin.saveData(data);
  }
}
