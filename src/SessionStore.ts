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
  terminal: Terminal;
  fitAddon: FitAddon;
  containerEl: HTMLElement;
  process: ChildProcess | null;
  documentListeners: { event: string; handler: EventListener }[];
  resizeObserver: ResizeObserver;
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
}
