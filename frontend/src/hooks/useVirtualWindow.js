// hooks/useVirtualWindow.js — row-windowing for large tables.
//
// Renders only the rows visible in the scroll viewport plus a small
// overscan buffer on each side. Replaces a flat <tbody> when the row
// count is large (e.g. 10k+ rows × 46 cols = 460k DOM nodes if rendered
// naively — would freeze the page).
//
// Usage:
//   const vw = useVirtualWindow({
//     rowCount: rows.length,
//     rowHeight: 26,
//     overscan: 8,
//     scrollRef: containerRef,
//   });
//   return (
//     <tbody>
//       <tr style={{ height: vw.paddingTop }} />
//       {rows.slice(vw.startIdx, vw.endIdx).map((row, i) => ...)}
//       <tr style={{ height: vw.paddingBottom }} />
//     </tbody>
//   );

import { useEffect, useState, useCallback } from 'react';

export function useVirtualWindow({ rowCount, rowHeight, overscan = 8, scrollRef }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  const onScroll = useCallback((e) => {
    setScrollTop(e.target.scrollTop);
  }, []);

  useEffect(() => {
    const el = scrollRef?.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    el.addEventListener('scroll', onScroll, { passive: true });
    const onResize = () => setViewportH(el.clientHeight);
    window.addEventListener('resize', onResize);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [scrollRef, onScroll]);

  // Compute visible range.
  const visibleCount = Math.max(1, Math.ceil(viewportH / rowHeight));
  const startVisible = Math.floor(scrollTop / rowHeight);
  const startIdx = Math.max(0, startVisible - overscan);
  const endIdx = Math.min(rowCount, startVisible + visibleCount + overscan);

  const paddingTop = startIdx * rowHeight;
  const paddingBottom = Math.max(0, (rowCount - endIdx) * rowHeight);

  return { startIdx, endIdx, paddingTop, paddingBottom };
}
