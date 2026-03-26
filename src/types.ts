import type { ChildProcess } from "child_process";
import type { Terminal } from "@xterm/xterm";

export interface TaskSource {
  type: "slack" | "jira" | "confluence" | "prompt" | "other";
  id: string;
  url: string;
  captured: string;
}

export interface TaskPriority {
  score: number;
  deadline: string;
  impact: "low" | "medium" | "high" | "critical";
  "has-blocker": boolean;
  "blocker-context": string;
}

export type TaskState =
  | "priority"
  | "todo"
  | "active"
  | "done"
  | "abandoned";

export type KanbanColumn = "priority" | "todo" | "active" | "done";

export interface TaskFile {
  path: string;
  filename: string;
  state: TaskState;
  title: string;
  tags: string[];
  source: TaskSource;
  priority: TaskPriority;
  agentActionable: boolean;
  goal: string[];
  created: string;
  updated: string;
}

export interface TerminalSession {
  id: string;
  taskPath: string | null;
  label: string;
  process: ChildProcess | null;
  terminal: Terminal;
  containerEl: HTMLElement;
}

export const STATE_FOLDER_MAP: Record<KanbanColumn, string> = {
  priority: "priority",
  todo: "todo",
  active: "active",
  done: "archive",
};

export const COLUMN_LABELS: Record<KanbanColumn, string> = {
  priority: "Priority",
  todo: "To Do",
  active: "Active",
  done: "Done",
};

export const KANBAN_COLUMNS: KanbanColumn[] = [
  "priority",
  "active",
  "todo",
  "done",
];

export const VIEW_TYPE_TASK_TERMINAL = "task-terminal-view";

export interface TaskTerminalSettings {
  taskBasePath: string;
  defaultShell: string;
  claudeCommand: string;
  defaultTerminalCwd: string;
}

export const DEFAULT_SETTINGS: TaskTerminalSettings = {
  taskBasePath: "2 - Areas/Tasks",
  defaultShell: process.env.SHELL || "/bin/zsh",
  claudeCommand: "claude",
  defaultTerminalCwd: "",
};
