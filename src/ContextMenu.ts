export interface MenuItemDef {
  label: string;
  action: () => void;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuItem = MenuItemDef | MenuSeparator;

function isSeparator(item: MenuItem): item is MenuSeparator {
  return "separator" in item;
}

export class ContextMenu {
  private el: HTMLElement;
  private cleanup: (() => void) | null = null;

  constructor(items: MenuItem[], x: number, y: number) {
    this.el = document.createElement("div");
    this.el.addClass("task-context-menu");

    for (const item of items) {
      if (isSeparator(item)) {
        this.el.createDiv({ cls: "task-context-menu-sep" });
        continue;
      }
      const row = this.el.createDiv({ cls: "task-context-menu-item" });
      row.textContent = item.label;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        item.action();
        this.dismiss();
      });
    }

    document.body.appendChild(this.el);

    // Position, clamping to viewport
    const rect = this.el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    this.el.style.left = `${Math.max(0, left)}px`;
    this.el.style.top = `${Math.max(0, top)}px`;

    // Dismiss handlers
    const onClickOutside = (e: MouseEvent) => {
      if (!this.el.contains(e.target as Node)) this.dismiss();
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.dismiss();
    };
    const onScroll = () => this.dismiss();

    // Delay listener attachment so the triggering contextmenu event doesn't immediately dismiss
    requestAnimationFrame(() => {
      document.addEventListener("click", onClickOutside, true);
      document.addEventListener("contextmenu", onClickOutside, true);
      document.addEventListener("keydown", onKeydown, true);
      window.addEventListener("scroll", onScroll, true);
    });

    this.cleanup = () => {
      document.removeEventListener("click", onClickOutside, true);
      document.removeEventListener("contextmenu", onClickOutside, true);
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }

  private dismiss(): void {
    if (this.cleanup) {
      this.cleanup();
      this.cleanup = null;
    }
    this.el.remove();
  }
}
