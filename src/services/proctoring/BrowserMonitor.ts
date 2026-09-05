import type { ViolationType } from "../../types/exam";

type EventCallback = (
  type: ViolationType,
  metadata?: Record<string, unknown>,
) => void;

export class BrowserMonitor {
  private readonly callback: EventCallback;

  private fullscreenHandler: (() => void) | null =
    null;

  private visibilityHandler:
    (() => void) | null = null;

  private copyHandler: (() => void) | null = null;

  private pasteHandler: (() => void) | null = null;

  private cutHandler: (() => void) | null = null;

  private blurHandler: (() => void) | null = null;

  private keydownHandler:
    ((event: KeyboardEvent) => void) | null = null;

  private contextMenuHandler:
    ((event: MouseEvent) => void) | null = null;

  constructor(callback: EventCallback) {
    this.callback = callback;
  }

  start() {
    this.visibilityHandler = () => {
      if (
        document.visibilityState === "hidden"
      ) {
        this.callback("TAB_SWITCH");
      }
    };

    this.fullscreenHandler = () => {
      if (!document.fullscreenElement) {
        this.callback("FULLSCREEN_EXIT");
      }
    };

    this.copyHandler = () => {
      this.callback("COPY");
    };

    this.pasteHandler = () => {
      this.callback("PASTE");
    };

    this.cutHandler = () => {
      this.callback("CUT");
    };

    this.blurHandler = () => {
      this.callback("WINDOW_BLUR");
    };

    /**
     * Suspicious keyboard shortcuts.
     *
     * Ctrl+C / Ctrl+X / Ctrl+V are intentionally
     * excluded here because they are already covered
     * by the copy/cut/paste event handlers above.
     * Handling them here as well would double-count
     * a single user action.
     */
    this.keydownHandler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      const isCtrlOrMeta =
        event.ctrlKey || event.metaKey;

      const shortcutLabel =
        [
          event.ctrlKey ? "Ctrl" : "",
          event.metaKey ? "Meta" : "",
          event.altKey ? "Alt" : "",
          event.shiftKey ? "Shift" : "",
          event.key,
        ]
          .filter(Boolean)
          .join("+");

      let suspicious = false;

      // DevTools / view source.
      if (
        event.key === "F12" ||
        (isCtrlOrMeta &&
          event.shiftKey &&
          ["i", "j", "c", "k"].includes(key)) ||
        (isCtrlOrMeta && key === "u")
      ) {
        suspicious = true;
      }

      // Save / print / find / help — typical
      // exfiltration or lookup attempts.
      if (
        isCtrlOrMeta &&
        ["s", "p", "f", "h", "g"].includes(key)
      ) {
        suspicious = true;
      }

      // Tab navigation / window switching attempts.
      if (
        (isCtrlOrMeta && key === "tab") ||
        (event.altKey &&
          ["tab", "arrowleft", "arrowright"].includes(
            key,
          ))
      ) {
        suspicious = true;
      }

      // Screenshot / screen-capture keys.
      if (
        event.key === "PrintScreen" ||
        (event.metaKey &&
          event.shiftKey &&
          ["s", "3", "4", "5"].includes(key))
      ) {
        suspicious = true;
      }

      // Undo of a paste (attempt to hide pasted content).
      if (
        isCtrlOrMeta &&
        (key === "z" || key === "y")
      ) {
        suspicious = true;
      }

      if (!suspicious) {
        return;
      }

      event.preventDefault();

      this.callback("SHORTCUT", {
        shortcut: shortcutLabel,
      });
    };

    /**
     * Right-click is blocked during the exam.
     * The attempt itself is logged as a violation
     * because it usually precedes copy/inspect
     * attempts.
     */
    this.contextMenuHandler = (
      event: MouseEvent,
    ) => {
      event.preventDefault();

      this.callback("CONTEXT_MENU");
    };

    document.addEventListener(
      "visibilitychange",
      this.visibilityHandler,
    );

    document.addEventListener(
      "fullscreenchange",
      this.fullscreenHandler,
    );

    document.addEventListener(
      "copy",
      this.copyHandler,
    );

    document.addEventListener(
      "paste",
      this.pasteHandler,
    );

    document.addEventListener(
      "cut",
      this.cutHandler,
    );

    window.addEventListener(
      "blur",
      this.blurHandler,
    );

    document.addEventListener(
      "keydown",
      this.keydownHandler,
    );

    document.addEventListener(
      "contextmenu",
      this.contextMenuHandler,
    );
  }

  stop() {
    if (this.visibilityHandler) {
      document.removeEventListener(
        "visibilitychange",
        this.visibilityHandler,
      );
    }

    if (this.fullscreenHandler) {
      document.removeEventListener(
        "fullscreenchange",
        this.fullscreenHandler,
      );
    }

    if (this.copyHandler) {
      document.removeEventListener(
        "copy",
        this.copyHandler,
      );
    }

    if (this.pasteHandler) {
      document.removeEventListener(
        "paste",
        this.pasteHandler,
      );
    }

    if (this.cutHandler) {
      document.removeEventListener(
        "cut",
        this.cutHandler,
      );
    }

    if (this.blurHandler) {
      window.removeEventListener(
        "blur",
        this.blurHandler,
      );
    }

    if (this.keydownHandler) {
      document.removeEventListener(
        "keydown",
        this.keydownHandler,
      );
    }

    if (this.contextMenuHandler) {
      document.removeEventListener(
        "contextmenu",
        this.contextMenuHandler,
      );
    }
  }
}