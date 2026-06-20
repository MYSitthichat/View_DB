// lib/format.js — cell formatters used by both TableTab and SqlTab.

/**
 * Format a raw cell value for display in the table grid.
 * Handles timestamps (InfluxDB time column), null/undefined, and JSON objects.
 */
export function formatCell(cell, colName) {
  if (cell === null || cell === undefined) return 'null';
  if (colName === 'time' || colName === '_time') return formatLocalTime(cell);
  if (typeof cell === 'object') {
    try {
      return JSON.stringify(cell);
    } catch (_) {
      return String(cell);
    }
  }
  return String(cell);
}

/**
 * Format a timestamp value as YYYY-MM-DD HH:MM:SS in local time.
 * Returns "" for empty, or the original string when not parseable.
 */
export function formatLocalTime(val) {
  if (!val) return '';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) {
      return String(val).replace('T', ' ').replace('Z', '');
    }
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (_) {
    return String(val);
  }
}

/**
 * Map a tag name to a stable HSL colour. Used by ChartViewer for series
 * colouring and by tag chips in the navigator.
 */
export function stringToColor(str) {
  if (!str) return '#ffffff';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
  return '#' + '00000'.substring(0, 6 - c.length) + c;
}

/**
 * Return true when the column name looks like a time column.
 * Used to apply col-time styling and special formatting.
 */
export function isTimeColumn(name) {
  return name === 'time' || name === '_time';
}
