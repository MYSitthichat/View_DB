import React, { useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import { stringToColor } from '../lib/format.js';

const EMPTY_SENTINEL = '_dummy_empty_';
const MAX_CHART_POINTS = 500;

export function ChartViewer({ results, tab, fetchTablePreviewData, allFields }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [localSelectedColumns, setLocalSelectedColumns] = useState([]);

  const isBackendMode = !!fetchTablePreviewData;

  const safeAllFields = useMemo(() => {
    if (allFields && allFields.length > 0) return allFields;
    if (results && results.columns) {
      return results.columns.filter(c => c !== 'time' && c !== '_time' && c !== '_x');
    }
    return [];
  }, [allFields, results]);

  const selectedColumns = isBackendMode ? (tab?.selectedColumns || []) : localSelectedColumns;

  // Build chart-friendly data: { _x: time, [seriesName]: value }
  const data = useMemo(() => {
    if (!results || !results.rows || results.rows.length === 0) return [];

    let timeIdx = -1;
    const numericIndices = [];
    const seriesNames = [];

    results.columns.forEach((col, idx) => {
      if (col === 'time' || col === '_time') {
        timeIdx = idx;
      } else {
        numericIndices.push(idx);
        seriesNames.push(col);
      }
    });

    if (timeIdx === -1 && results.columns.length > 0) {
      timeIdx = 0; // fallback to first column as X axis
    }

    return results.rows.map(row => {
      let timeVal = row[timeIdx];
      try {
        const d = new Date(timeVal);
        if (!isNaN(d.getTime())) {
          const pad = (n) => n.toString().padStart(2, '0');
          timeVal = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }
      } catch (_) { /* ignore */ }

      const point = { _x: timeVal };
      numericIndices.forEach((colIdx, i) => {
        point[seriesNames[i]] = row[colIdx];
      });
      return point;
    });
  }, [results]);

  // Downsample to <= MAX_CHART_POINTS for Recharts performance.
  const chartData = useMemo(() => {
    if (data.length <= MAX_CHART_POINTS) return data;
    const step = Math.ceil(data.length / MAX_CHART_POINTS);
    return data.filter((_, i) => i % step === 0);
  }, [data]);

  React.useEffect(() => {
    if (isBackendMode) {
      if (safeAllFields.length > 0 && selectedColumns.length === 0 && !tab?.hasUserSelectedColumns) {
        const initCols = safeAllFields.slice(0, 3).filter(Boolean);
        if (initCols.length > 0) {
          fetchTablePreviewData(tab.id, tab.db, tab.table, {
            selectedColumns: initCols,
            offset: 0,
            clearExisting: true,
            hasUserSelectedColumns: true,
          });
        }
      }
    } else if (safeAllFields.length > 0 && localSelectedColumns.length === 0) {
      setLocalSelectedColumns(safeAllFields);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBackendMode, safeAllFields, selectedColumns.length, tab?.hasUserSelectedColumns]);

  const applySelection = (nextCols) => {
    const safe = nextCols.length === 0 ? [EMPTY_SENTINEL] : nextCols;
    if (isBackendMode) {
      fetchTablePreviewData(tab.id, tab.db, tab.table, {
        selectedColumns: safe,
        offset: 0,
        clearExisting: true,
        hasUserSelectedColumns: true,
      });
    } else {
      setLocalSelectedColumns(safe);
    }
  };

  const toggleKey = (key) => {
    const next = selectedColumns.includes(key)
      ? selectedColumns.filter(c => c !== key)
      : [...selectedColumns, key];
    applySelection(next);
  };

  const toggleAll = (select) => {
    applySelection(select ? safeAllFields.filter(Boolean) : []);
  };

  if (data.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
        No data available for chart.
      </div>
    );
  }

  const filteredKeys = safeAllFields.filter(
    k => k && k.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const visibleSelected = selectedColumns.filter(c => c && c !== EMPTY_SENTINEL);
  const noSelection = selectedColumns.length === 0 || selectedColumns.includes(EMPTY_SENTINEL);

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', minHeight: 400 }}>
      <div style={{ flex: '3', position: 'relative', overflow: 'hidden' }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="_x" stroke="#888" tick={{ fill: '#888', fontSize: 12 }} />
            <YAxis stroke="#888" tick={{ fill: '#888', fontSize: 12 }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1e1e24', borderColor: '#333', color: '#fff', fontSize: '0.8rem' }}
              itemStyle={{ padding: 0 }}
            />
            {visibleSelected.map(key => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={stringToColor(key)}
                dot={false}
                activeDot={{ r: 4 }}
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        {noSelection && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'var(--text-muted)' }}>
            Select series from the right to view data
          </div>
        )}
      </div>

      <div style={{ flex: '1', borderLeft: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', background: 'var(--bg-lighter)' }}>
        <div style={{ padding: '12px', borderBottom: '1px solid var(--border-color)' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '0.85rem' }}>
            Series ({visibleSelected.length}/{safeAllFields.length})
          </h4>
          <input
            type="text"
            placeholder="🔍 Search tags..."
            className="filter-input"
            style={{ width: '100%', padding: '6px', fontSize: '0.75rem', marginBottom: '8px' }}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div style={{ display: 'flex', gap: '4px' }}>
            <button className="ghost-btn" style={{ flex: 1, padding: '4px', fontSize: '0.7rem' }} onClick={() => toggleAll(true)}>All</button>
            <button className="ghost-btn" style={{ flex: 1, padding: '4px', fontSize: '0.7rem' }} onClick={() => toggleAll(false)}>None</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
          {filteredKeys.map(key => {
            const isVisible = selectedColumns.includes(key);
            const color = stringToColor(key);
            return (
              <label
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '4px 8px',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  borderRadius: '4px',
                  background: isVisible ? 'rgba(255,255,255,0.05)' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={() => toggleKey(key)}
                  style={{ accentColor: color, cursor: 'pointer' }}
                />
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }}></span>
                <span style={{ color: isVisible ? 'var(--text-primary)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={key}>
                  {key}
                </span>
              </label>
            );
          })}
          {filteredKeys.length === 0 && (
            <div style={{ padding: '8px', fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
              No tags match search.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
