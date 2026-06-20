// hooks/useKeyboardShortcuts.js — global keyboard shortcuts.
//
// Mount once at the App level. Recognised shortcuts:
//   Ctrl/Cmd+Enter   → run query in active SQL tab
//   Ctrl/Cmd+S       → save active query
//   Ctrl/Cmd+L       → focus query editor (SQL tab) / clear filter (table tab)
//   Ctrl/Cmd+K       → next tab
//   Ctrl/Cmd+J       → previous tab
//   Escape           → close notification banner
//
// Shortcuts are no-ops when focus is in an input/textarea — this prevents
// stealing keys while the user is typing in the connection form or query
// editor. We only intercept shortcuts when no input is focused OR the
// modifier is held.
import { useEffect } from 'react';

const ALLOWED_IN_INPUT = new Set(['Control', 'Meta', 'Alt', 'Shift']);

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(handlers) {
  useEffect(() => {
    function onKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      const inInput = isTypingTarget(e.target);

      // Allow Ctrl/Cmd shortcuts from anywhere (including inputs).
      if (mod) {
        const key = e.key.toLowerCase();
        // Ctrl+Enter → run query
        if (key === 'enter' && handlers.runQuery) {
          e.preventDefault();
          handlers.runQuery();
          return;
        }
        // Ctrl+S → save
        if (key === 's' && handlers.saveQuery) {
          e.preventDefault();
          handlers.saveQuery();
          return;
        }
        // Ctrl+K → next tab
        if (key === 'k' && handlers.nextTab) {
          e.preventDefault();
          handlers.nextTab();
          return;
        }
        // Ctrl+J → previous tab
        if (key === 'j' && handlers.prevTab) {
          e.preventDefault();
          handlers.prevTab();
          return;
        }
      }

      if (inInput) return;

      // Escape → dismiss notification
      if (e.key === 'Escape' && handlers.dismissNotification) {
        handlers.dismissNotification();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}
