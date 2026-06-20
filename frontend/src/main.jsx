import React, { useEffect, useMemo, useState, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import './styles.css';

const emptyProfile = {
  id: '',
  name: '',
  version: 'v2',
  url: '',
  username: '',
  password: '',
  token: '',
  organization: '',
  bucket: '',
  database: '',
  retentionPolicy: '',
  tlsInsecure: true,
  timeoutSeconds: 30,
};

const getQueryTemplate = (version, databaseOrBucket, measurement = 'cpu') => {
  if (version === 'v2') {
    return `from(bucket: "${databaseOrBucket || 'telegraf'}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "${measurement}")
  |> limit(n: 1000)`;
  } else if (version === 'v3') {
    return `SELECT * FROM "${measurement}" WHERE time > now() - interval '1 hour' LIMIT 10`;
  } else {
    return `SELECT * FROM "${measurement}" WHERE time > now() - 1h LIMIT 10`;
  }
};

const timeRangeInterval = (range) => {
  switch (range) {
    case '15m': return '15 minutes';
    case '1h': return '1 hour';
    case '6h': return '6 hours';
    case '12h': return '12 hours';
    case '24h': return '24 hours';
    case '7d': return '7 days';
    case '30d': return '30 days';
    default: return '1 hour';
  }
};

const formatLocalTime = (val) => {
  if (!val) return '';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val).replace('T', ' ').replace('Z', '');
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (e) {
    return String(val);
  }
};

const getTablePreviewQuery = (version, databaseOrBucket, measurement, sortOrder = 'desc', limit = 20, offset = 0, timeRange = 'all', selectedColumns = []) => {
  if (version === 'v2') {
    let rangeStr = timeRange !== 'custom' ? `|> range(start: -${timeRange})` : `|> range(start: -1h)`;
    if (timeRange === 'all') {
      rangeStr = `|> range(start: 0)`;
    }
    let fieldFilter = '';
    if (selectedColumns && selectedColumns.length > 0) {
      const conditions = selectedColumns.map(c => `r._field == "${c}"`).join(' or ');
      fieldFilter = `|> filter(fn: (r) => ${conditions})`;
    }

    return `from(bucket: "${databaseOrBucket || 'telegraf'}")
  ${rangeStr}
  |> filter(fn: (r) => r._measurement == "${measurement}")
  ${fieldFilter}
  |> sort(columns: ["_time"], desc: ${sortOrder === 'desc'})
  |> limit(n: ${limit}, offset: ${offset})`;
  } else if (version === 'v3') {
    let whereStr = '';
    if (timeRange === 'all') {
      whereStr = '';
    } else if (timeRange === 'custom') {
      whereStr = `WHERE time > now() - INTERVAL '1 hour'`;
    } else {
      const intervalStr = timeRangeInterval(timeRange);
      whereStr = `WHERE time > now() - INTERVAL '${intervalStr}'`;
    }
    const orderStr = `ORDER BY time ${sortOrder.toUpperCase()}`;
    const limitStr = `LIMIT ${limit} OFFSET ${offset}`;
    
    let selectStr = '*';
    if (selectedColumns && selectedColumns.length > 0) {
      selectStr = `"time", ` + selectedColumns.map(c => `"${c}"`).join(', ');
    }
    
    return `SELECT ${selectStr} FROM "${measurement}" ${whereStr} ${orderStr} ${limitStr}`;
  } else if (version === 'v1') {
    let whereStr = '';
    if (timeRange === 'all') {
      whereStr = '';
    } else if (timeRange === 'custom') {
      whereStr = `WHERE time > now() - 1h`;
    } else {
      whereStr = `WHERE time > now() - ${timeRange}`;
    }
    const orderStr = `ORDER BY time ${sortOrder.toUpperCase()}`;
    const limitStr = `LIMIT ${limit} OFFSET ${offset}`;
    
    let selectStr = '*';
    if (selectedColumns && selectedColumns.length > 0) {
      selectStr = `time, ` + selectedColumns.map(c => `"${c}"`).join(', ');
    }
    
    return `SELECT ${selectStr} FROM "${measurement}" ${whereStr} ${orderStr} ${limitStr}`;
  }
};

const downsampleToOneSecond = (columns, rows) => {
  const timeColIdx = columns.indexOf('time');
  if (timeColIdx === -1) return rows;

  const seenSeconds = new Map();

  for (const row of rows) {
    const timeVal = row[timeColIdx];
    if (!timeVal) continue;
    const timeStr = String(timeVal);
    const secondKey = timeStr.split('.')[0].replace('Z', ''); 

    const existing = seenSeconds.get(secondKey);
    if (!existing) {
      seenSeconds.set(secondKey, row);
    } else {
      const existingNullCount = existing.filter(v => v === null || v === undefined || v === 'null').length;
      const currentNullCount = row.filter(v => v === null || v === undefined || v === 'null').length;
      if (currentNullCount < existingNullCount) {
        seenSeconds.set(secondKey, row);
      }
    }
  }

  return Array.from(seenSeconds.values());
};

function TableTabContent({ tab, treeData, fetchTablePreviewData, selectedConnection, exportTabResult }) {
  const [activeSubTab, setActiveSubTab] = React.useState('data');
  const [viewMode, setViewMode] = React.useState('table');
  const [columnSearch, setColumnSearch] = React.useState('');
  const cacheKey = `${tab.db}:${tab.table}`;
  const fields = treeData.fields[cacheKey] || [];
  const tags = treeData.tags[cacheKey] || [];
  const results = tab.queryResult || { columns: [], rows: [], count: 0 };

  const containerRef = React.useRef(null);
  const loadingRef = React.useRef(false);
  const lastScrollTopRef = React.useRef(0);

  // Compute a min-width so columns never collapse, even with very short values.
  // 160px per column + 56px row index + 32px slack guarantees the horizontal
  // scrollbar appears on wide schemas (30-150+ columns).
  const tableMinWidth = React.useMemo(() => {
    const colCount = Math.max(results.columns?.length || 0, 1);
    return `${56 + colCount * 160 + 32}px`;
  }, [results.columns]);

  const handleFindColumn = () => {
    if (!columnSearch || !containerRef.current) return;
    const search = columnSearch.toLowerCase();
    const headers = containerRef.current.querySelectorAll('thead th.col-data-hdr');
    let target = null;
    for (const th of headers) {
      const lbl = th.querySelector('.col-header-txt');
      if (lbl && lbl.textContent.toLowerCase().includes(search)) {
        target = th;
        break;
      }
    }
    if (!target) return;

    // Scroll the found column into view (centered horizontally).
    target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

    // Highlight temporarily without trampling the sticky-top background.
    target.classList.add('col-header-found');
    setTimeout(() => target.classList.remove('col-header-found'), 2000);
  };

  React.useEffect(() => {
    loadingRef.current = tab.loading;
  }, [tab.loading]);

  React.useEffect(() => {
    if (containerRef.current && tab.offset === 0) {
      containerRef.current.scrollTop = 0;
    }
  }, [tab.offset, tab.sortOrder, tab.timeRange, tab.customStart, tab.customEnd]);

  // Stable formatter — guards against unexpected types from Go's []any
  const formatCell = React.useCallback((cell, colName) => {
    if (cell === null || cell === undefined) return 'null';
    if (colName === 'time' || colName === '_time') return formatLocalTime(cell);
    if (typeof cell === 'object') {
      try { return JSON.stringify(cell); } catch (_) { return String(cell); }
    }
    return String(cell);
  }, []);

  const isTimeCol = React.useCallback((c) => c === 'time' || c === '_time', []);

  return (
    <div className="table-tab-container">
      {/* Sub-tabs bar: Properties, Data */}
      <div className="sub-tabs-bar">
        <button 
          className={`sub-tab-btn ${activeSubTab === 'properties' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('properties')}
        >
          ℹ️ Properties
        </button>
        <button 
          className={`sub-tab-btn ${activeSubTab === 'data' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('data')}
        >
          📊 Data
        </button>
      </div>

      <div className="sub-tab-content">
        {activeSubTab === 'properties' ? (
          <div className="properties-tab-content">
            <h3 style={{ margin: '0 0 10px 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>COLUMNS ({fields.length + tags.length})</h3>
            <div className="table-wrap" style={{ maxHeight: '100%', marginTop: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Column Name</th>
                    <th>Type</th>
                    <th>Kind</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map(f => (
                    <tr key={f.name}>
                      <td style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{f.name}</td>
                      <td style={{ color: 'var(--accent-cyan)' }}>{f.type || 'float'}</td>
                      <td>Field</td>
                    </tr>
                  ))}
                  {tags.map(t => (
                    <tr key={t.name}>
                      <td style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{t.name}</td>
                      <td style={{ color: 'var(--accent-emerald)' }}>string</td>
                      <td>Tag</td>
                    </tr>
                  ))}
                  {fields.length === 0 && tags.length === 0 && (
                    <tr>
                      <td colSpan="3" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                        No columns loaded. Expand the node in the Database Navigator to load schema metadata.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="data-tab-content">
            {/* Filter Bar */}
            <div className="filter-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
              <span className="filter-label" style={{ marginRight: '4px' }}>Scan Window:</span>
              <select 
                className="filter-select"
                value={tab.timeRange || 'all'}
                onChange={(e) => {
                  fetchTablePreviewData(tab.id, tab.db, tab.table, {
                    timeRange: e.target.value,
                    offset: 0,
                    clearExisting: true
                  });
                }}
              >
                <option value="all">Latest (No Time Limit)</option>
                <option value="15m">Last 15 minutes</option>
                <option value="1h">Last 1 hour</option>
                <option value="6h">Last 6 hours</option>
                <option value="12h">Last 12 hours</option>
                <option value="24h">Last 24 hours</option>
              </select>

              <select 
                className="filter-select"
                value={tab.sortOrder || 'desc'}
                onChange={(e) => {
                  fetchTablePreviewData(tab.id, tab.db, tab.table, {
                    sortOrder: e.target.value,
                    offset: 0,
                    clearExisting: true
                  });
                }}
              >
                <option value="desc">⬇️ Latest (Newest first)</option>
                <option value="asc">⬆️ Oldest (Oldest first)</option>
              </select>

              <select 
                className="filter-select"
                value={tab.limit || 20}
                onChange={(e) => {
                  fetchTablePreviewData(tab.id, tab.db, tab.table, {
                    limit: parseInt(e.target.value, 10),
                    offset: 0,
                    clearExisting: true
                  });
                }}
              >
                <option value="10">10 rows</option>
                <option value="20">20 rows</option>
                <option value="30">30 rows</option>
                <option value="50">50 rows</option>
                <option value="100">100 rows</option>
                <option value="200">200 rows</option>
              </select>

              {viewMode === 'table' && (
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <input 
                    type="text" 
                    className="filter-input" 
                    placeholder="Find Column..."
                    style={{ width: '150px', padding: '6px 8px', fontSize: '0.75rem', background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                    value={columnSearch}
                    onChange={(e) => setColumnSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleFindColumn();
                    }}
                    title="Find and scroll to column"
                  />
                  <button 
                    className="ghost-btn" 
                    style={{ padding: '6px 12px', fontSize: '0.75rem', border: '1px solid var(--border-color)' }} 
                    onClick={handleFindColumn}
                  >
                    Find
                  </button>
                </div>
              )}

              <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
                <span
                  style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                  title={`Showing ${results.columns?.length || 0} column(s)`}
                >
                  {results.columns?.length || 0} cols
                </span>
                <button
                  className="ghost-btn"
                  style={{ padding: '6px 10px', fontSize: '0.7rem' }}
                  onClick={() => {
                    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, selectedColumns: [] } : t));
                    fetchTablePreviewData(tab.id, tab.db, tab.table, { selectedColumns: [], offset: 0, clearExisting: true });
                  }}
                  disabled={tab.loading}
                  title="Reset to all schema columns"
                >
                  ↺ All Cols
                </button>
                <button
                  className="primary-btn"
                  style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                  onClick={() => fetchTablePreviewData(tab.id, tab.db, tab.table, { offset: 0, clearExisting: true })}
                  disabled={tab.loading}
                >
                  {tab.loading && results.rows.length === 0 ? 'Loading...' : 'Refresh'}
                </button>
                <div className="view-toggle" style={{ display: 'flex', background: 'var(--bg-lighter)', padding: 2, borderRadius: 4 }}>
                  <button 
                    className={`toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
                    style={{ padding: '6px 12px', fontSize: '0.75rem', background: viewMode === 'table' ? 'var(--accent-cyan)' : 'transparent', color: viewMode === 'table' ? '#000' : 'var(--text-primary)', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                    onClick={() => setViewMode('table')}
                  >
                    Table
                  </button>
                  <button 
                    className={`toggle-btn ${viewMode === 'chart' ? 'active' : ''}`}
                    style={{ padding: '6px 12px', fontSize: '0.75rem', background: viewMode === 'chart' ? 'var(--accent-cyan)' : 'transparent', color: viewMode === 'chart' ? '#000' : 'var(--text-primary)', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                    onClick={() => setViewMode('chart')}
                  >
                    Chart
                  </button>
                </div>
                <button 
                  className="ghost-btn" 
                  style={{ padding: '6px 12px', fontSize: '0.75rem' }} 
                  onClick={() => exportTabResult(tab.id, 'csv')} 
                  disabled={!results.rows.length}
                >
                  Export CSV
                </button>
                <button 
                  className="ghost-btn" 
                  style={{ padding: '6px 12px', fontSize: '0.75rem' }} 
                  onClick={() => exportTabResult(tab.id, 'json')} 
                  disabled={!results.rows.length}
                >
                  Export JSON
                </button>
              </div>
            </div>

            {/* Spreadsheet Grid */}
            <div
              ref={containerRef}
              className="table-wrap spreadsheet-wrap"
              style={{ flex: 1, maxHeight: '100%', marginTop: 0, overflow: viewMode === 'chart' ? 'hidden' : 'auto' }}
            >
              {viewMode === 'table' ? (
                <table style={{ minWidth: tableMinWidth }}>
                  <thead>
                    <tr>
                    <th className="row-index-hdr">#</th>
                    {results.columns.map(col => (
                      <th key={`hdr-${col}`} className="col-data-hdr" title={col}>
                        <span className="col-header-txt">{col}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map((row, rIdx) => {
                    const globalRowIdx = (tab.offset || 0) + rIdx + 1;
                    return (
                      <tr key={`r-${rIdx}`}>
                        <td className="row-index-cell">{globalRowIdx}</td>
                        {row.map((cell, cIdx) => {
                          const colName = results.columns[cIdx] || '';
                          const display = formatCell(cell, colName);
                          return (
                            <td
                              key={`c-${rIdx}-${cIdx}`}
                              className={`cell-data ${isTimeCol(colName) ? 'col-time' : ''}`}
                              title={display}
                            >
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {results.rows.length === 0 && !tab.loading && (
                    <tr>
                      <td colSpan={(results.columns?.length || 0) + 1} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)' }}>
                        No data found. Click Refresh or check your database connection.
                      </td>
                    </tr>
                  )}
                  {tab.loading && results.rows.length === 0 && (
                    <tr>
                      <td colSpan={(results.columns?.length || 0) + 1} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--accent-cyan)' }}>
                        Loading table data preview...
                      </td>
                    </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <ChartViewer
                  results={results}
                  tab={tab}
                  fetchTablePreviewData={fetchTablePreviewData}
                  allFields={fields.map(f => f.name).concat(tags.map(t => t.name))}
                />
              )}
            </div>

            <div className="grid-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--panel-border)', background: '#05080e' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button 
                  className="ghost-btn" 
                  style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => fetchTablePreviewData(tab.id, tab.db, tab.table, { offset: 0, clearExisting: true })}
                  disabled={tab.loading || (tab.offset || 0) === 0}
                >
                  ⏮️ First
                </button>
                <button 
                  className="ghost-btn" 
                  style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => {
                    const prevOffset = Math.max(0, (tab.offset || 0) - (tab.limit || 20));
                    fetchTablePreviewData(tab.id, tab.db, tab.table, { offset: prevOffset, clearExisting: true });
                  }}
                  disabled={tab.loading || (tab.offset || 0) === 0}
                >
                  ◀️ Prev
                </button>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', margin: '0 4px', fontWeight: 'bold' }}>
                  Page {Math.floor((tab.offset || 0) / (tab.limit || 20)) + 1}
                </span>
                <button 
                  className="ghost-btn" 
                  style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => {
                    const nextOffset = (tab.offset || 0) + (tab.limit || 20);
                    fetchTablePreviewData(tab.id, tab.db, tab.table, { offset: nextOffset, clearExisting: true });
                  }}
                  disabled={tab.loading || !tab.hasMore}
                >
                  Next ▶️
                </button>
              </div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                {tab.loading && <span>⏳ Loading...</span>}
                <span>{results.rows.length} row(s) on page</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function stringToColor(str) {
  if (!str) return '#ffffff';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
  return '#' + '00000'.substring(0, 6 - c.length) + c;
}

// Lightweight error boundary so a render crash in a tab doesn't kill the UI.
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error('App crashed:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: '#fda4af', fontFamily: 'var(--font-mono)' }}>
          <h2 style={{ margin: '0 0 12px', color: 'var(--accent-rose)' }}>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            className="primary-btn"
            style={{ marginTop: 16 }}
            onClick={() => this.setState({ error: null })}
          >
            Reset
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ChartViewer({ results, tab, fetchTablePreviewData, allFields }) {
  const [searchQuery, setSearchQuery] = React.useState('');
  
  // Determine if we are in Backend Filtering mode (Table Tab) or Frontend Filtering mode (SQL Tab)
  const isBackendMode = !!fetchTablePreviewData;
  
  // For Frontend mode
  const [localSelectedColumns, setLocalSelectedColumns] = React.useState([]);

  const safeAllFields = React.useMemo(() => {
    if (allFields && allFields.length > 0) return allFields;
    if (results && results.columns) return results.columns.filter(c => c !== 'time' && c !== '_time' && c !== '_x');
    return [];
  }, [allFields, results]);

  const selectedColumns = isBackendMode ? (tab?.selectedColumns || []) : localSelectedColumns;

  const data = useMemo(() => {
    if (!results || !results.rows || results.rows.length === 0) return [];
    
    // Find time column and numeric columns
    let timeIdx = -1;
    const numericIndices = [];
    const seriesNames = [];
    
    results.columns.forEach((col, idx) => {
      if (col === 'time' || col === '_time') {
        timeIdx = idx;
      } else {
        // We will assume non-time columns are potential series if they contain numbers
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
      } catch (e) {}
      
      const point = { _x: timeVal };
      numericIndices.forEach((colIdx, i) => {
        point[seriesNames[i]] = row[colIdx];
      });
      return point;
    });
  }, [results]);

  // Downsample to max 500 points for Recharts to prevent SVG freezing
  const chartData = useMemo(() => {
    if (data.length <= 500) return data;
    const step = Math.ceil(data.length / 500);
    return data.filter((_, i) => i % step === 0);
  }, [data]);

  React.useEffect(() => {
    if (isBackendMode) {
      // Only auto-select if we haven't made a selection yet and fields are available
      if (safeAllFields && safeAllFields.length > 0 && selectedColumns.length === 0 && !tab.hasUserSelectedColumns) {
        const initCols = safeAllFields.slice(0, 3).filter(Boolean);
        if (initCols.length > 0) {
          fetchTablePreviewData(tab.id, tab.db, tab.table, {
            selectedColumns: initCols,
            offset: 0,
            clearExisting: true,
            hasUserSelectedColumns: true
          });
        }
      }
    } else {
      // Frontend mode: auto-select all columns initially
      if (safeAllFields && safeAllFields.length > 0 && localSelectedColumns.length === 0) {
        setLocalSelectedColumns(safeAllFields);
      }
    }
  }, [isBackendMode, safeAllFields, selectedColumns.length, tab, fetchTablePreviewData, localSelectedColumns.length]);

  if (data.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
        No data available for chart.
      </div>
    );
  }

  const filteredKeys = safeAllFields.filter(k => k && k.toLowerCase().includes(searchQuery.toLowerCase()));

  const toggleKey = (key) => {
    let nextCols = [...selectedColumns];
    if (nextCols.includes(key)) {
      nextCols = nextCols.filter(c => c !== key);
    } else {
      nextCols.push(key);
    }
    
    // Ensure we don't query * if it's empty, instead query a dummy or let it be empty
    // But actually, if they uncheck all, we can just pass a special flag or just query nothing.
    // Let's pass a dummy column to prevent SELECT * if they uncheck everything in backend mode.
    if (nextCols.length === 0) {
      nextCols = ['_dummy_empty_'];
    }
    
    if (isBackendMode) {
      fetchTablePreviewData(tab.id, tab.db, tab.table, {
        selectedColumns: nextCols,
        offset: 0,
        clearExisting: true,
        hasUserSelectedColumns: true
      });
    } else {
      setLocalSelectedColumns(nextCols);
    }
  };

  const toggleAll = (select) => {
    if (isBackendMode) {
      fetchTablePreviewData(tab.id, tab.db, tab.table, {
        selectedColumns: select ? safeAllFields.filter(Boolean) : ['_dummy_empty_'],
        offset: 0,
        clearExisting: true,
        hasUserSelectedColumns: true
      });
    } else {
      setLocalSelectedColumns(select ? safeAllFields.filter(Boolean) : ['_dummy_empty_']);
    }
  };

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
            {selectedColumns.filter(k => k && k !== '_dummy_empty_').map(key => (
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
        {selectedColumns.length === 0 || selectedColumns.includes('_dummy_empty_') ? (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'var(--text-muted)' }}>
            Select series from the right to view data
          </div>
        ) : null}
      </div>

      <div style={{ flex: '1', borderLeft: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', background: 'var(--bg-lighter)' }}>
        <div style={{ padding: '12px', borderBottom: '1px solid var(--border-color)' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '0.85rem' }}>Series ({selectedColumns.filter(c => c && c !== '_dummy_empty_').length}/{safeAllFields.length})</h4>
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
                  background: isVisible ? 'rgba(255,255,255,0.05)' : 'transparent'
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

function SqlTabContent({ tab, runSqlTabQuery, cancelSqlTabQuery, updateTabQuery, exportTabResult, saveQuery }) {
  const results = tab.queryResult || { columns: [], rows: [], count: 0 };
  const [viewMode, setViewMode] = useState('table');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);

  // Reset page to 1 when query results change (e.g. new query ran)
  useEffect(() => {
    setPage(1);
  }, [results.rows]);

  const totalPages = Math.ceil((results.rows?.length || 0) / pageSize) || 1;

  const displayedRows = useMemo(() => {
    if (!results.rows) return [];
    const startIndex = (page - 1) * pageSize;
    return results.rows.slice(startIndex, startIndex + pageSize);
  }, [results.rows, page, pageSize]);

  return (
    <div className="sql-tab-container">
      <section className="editor panel" style={{ flexShrink: 0, padding: 12 }}>
        <div className="editor-header">
          <div className="panel-title">Query Editor</div>
          <div className="editor-badges">
            <span>Limit 1000</span>
            <span>Default Range 1h</span>
          </div>
        </div>
        <textarea 
          className="query-editor" 
          value={tab.query} 
          onChange={(e) => updateTabQuery(tab.id, e.target.value)} 
          placeholder="SELECT * FROM ..."
          style={{ minHeight: 100 }}
        />
        <div className="stack-actions" style={{ marginTop: 8, justifyContent: 'flex-end', gap: 8 }}>
          {tab.runningQueryId ? (
            <button className="danger-btn" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => cancelSqlTabQuery(tab.id)}>
              Cancel ({tab.elapsedTime}s)
            </button>
          ) : (
            <>
              <button className="ghost-btn" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => saveQuery(tab)}>
                Save Query
              </button>
              <button className="primary-btn" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => runSqlTabQuery(tab.id)}>
                Run Query
              </button>
            </>
          )}
        </div>
      </section>

      <section className="results panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12 }}>
        <div className="panel-title-row" style={{ marginBottom: 8 }}>
          <div className="panel-title">Query Results</div>
          <div className="result-summary">{results.count || 0} rows · {results.columns?.length || 0} columns</div>
        </div>
        
        <div className="stack-actions" style={{ marginBottom: 8, gap: 6 }}>
          <div className="view-toggle" style={{ display: 'flex', background: 'var(--bg-lighter)', padding: 2, borderRadius: 4, marginRight: 'auto' }}>
            <button 
              className={`toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
              style={{ padding: '4px 12px', fontSize: '0.75rem', background: viewMode === 'table' ? 'var(--accent-cyan)' : 'transparent', color: viewMode === 'table' ? '#000' : 'inherit', border: 'none', borderRadius: 4, cursor: 'pointer' }}
              onClick={() => setViewMode('table')}
            >
              Table
            </button>
            <button 
              className={`toggle-btn ${viewMode === 'chart' ? 'active' : ''}`}
              style={{ padding: '4px 12px', fontSize: '0.75rem', background: viewMode === 'chart' ? 'var(--accent-cyan)' : 'transparent', color: viewMode === 'chart' ? '#000' : 'inherit', border: 'none', borderRadius: 4, cursor: 'pointer' }}
              onClick={() => setViewMode('chart')}
            >
              Chart
            </button>
          </div>
          <button className="ghost-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => exportTabResult(tab.id, 'csv')} disabled={!tab.lastQueryId}>Export CSV</button>
          <button className="ghost-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => exportTabResult(tab.id, 'json')} disabled={!tab.lastQueryId}>Export JSON</button>
        </div>
        
        <div className="table-wrap spreadsheet-wrap" style={{ flex: 1, maxHeight: '100%', marginTop: 0, overflow: viewMode === 'chart' ? 'hidden' : 'auto' }}>
          {viewMode === 'table' ? (
          <table style={{ minWidth: `${56 + ((results.columns?.length || 0) * 160 + 32)}px` }}>
            <thead>
              <tr>
                <th className="row-index-hdr">#</th>
                {(results.columns || []).map((column) => (
                  <th key={`sql-hdr-${column}`} className="col-data-hdr" title={column}>
                    <span className="col-header-txt">{column}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row, index) => {
                const globalIndex = (page - 1) * pageSize + index;
                return (
                  <tr key={`sql-r-${globalIndex}`}>
                    <td className="row-index-cell">{globalIndex + 1}</td>
                    {(row || []).map((cell, cellIndex) => {
                      const colName = (results.columns || [])[cellIndex] || '';
                      let display;
                      if (cell === null || cell === undefined) {
                        display = 'null';
                      } else if (colName === 'time' || colName === '_time') {
                        display = formatLocalTime(cell);
                      } else if (typeof cell === 'object') {
                        try { display = JSON.stringify(cell); } catch (_) { display = String(cell); }
                      } else {
                        display = String(cell);
                      }
                      return (
                        <td
                          key={`sql-c-${globalIndex}-${cellIndex}`}
                          className={`cell-data ${colName === 'time' || colName === '_time' ? 'col-time' : ''}`}
                          title={display}
                        >
                          {display}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {results.rows.length === 0 && !tab.loading && (
                <tr>
                  <td colSpan={(results.columns?.length || 0) + 1} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)' }}>
                    No data loaded. Write query and run.
                  </td>
                </tr>
              )}
              {tab.loading && (
                <tr>
                  <td colSpan={(results.columns?.length || 0) + 1} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--accent-cyan)' }}>
                    Executing SQL query...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          ) : (
            <ChartViewer results={results} />
          )}
        </div>

        {viewMode === 'table' && results.rows.length > 0 && (
          <div className="grid-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--panel-border)', background: '#05080e', marginTop: '8px', borderRadius: '4px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button 
                className="ghost-btn" 
                style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => setPage(1)}
                disabled={page === 1}
              >
                ⏮️ First
              </button>
              <button 
                className="ghost-btn" 
                style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                ◀️ Prev
              </button>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', margin: '0 4px', fontWeight: 'bold' }}>
                Page {page} of {totalPages}
              </span>
              <button 
                className="ghost-btn" 
                style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
              >
                Next ▶️
              </button>
              <button 
                className="ghost-btn" 
                style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => setPage(totalPages)}
                disabled={page === totalPages}
              >
                Last ⏭️
              </button>
            </div>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Page size:</span>
              <select 
                className="filter-select"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(parseInt(e.target.value, 10));
                  setPage(1);
                }}
                style={{ padding: '4px 8px', fontSize: '0.75rem' }}
              >
                <option value="50">50 rows</option>
                <option value="100">100 rows</option>
                <option value="200">200 rows</option>
                <option value="500">500 rows</option>
                <option value="1000">1000 rows</option>
              </select>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                {results.rows.length} total row(s)
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function App() {
  const [connections, setConnections] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [connectedId, setConnectedId] = useState('');
  const [profile, setProfile] = useState(emptyProfile);
  const [contextMenu, setContextMenu] = useState(null);
  
  const [formDatabases, setFormDatabases] = useState([]);
  const [treeData, setTreeData] = useState({
    databases: [],
    tables: {},
    fields: {},
    tags: {},
  });
  const [expandedNodes, setExpandedNodes] = useState({});
  const [loadingNodes, setLoadingNodes] = useState({});

  const [activeDatabase, setActiveDatabase] = useState('');
  const [activeMeasurement, setActiveMeasurement] = useState('');
  
  const [status, setStatus] = useState('Ready');
  const [message, setMessage] = useState('');
  const [notification, setNotification] = useState(null);
  
  const [showSettings, setShowSettings] = useState(false);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [sqlTabCount, setSqlTabCount] = useState(1);

  const [queryHistory, setQueryHistory] = useState([]);
  const [savedQueries, setSavedQueries] = useState([]);

  const selected = useMemo(() => connections.find((c) => c.id === selectedId) || null, [connections, selectedId]);

  useEffect(() => { 
    refreshConnections(); 
    loadSavedQueries();
    loadQueryHistory();

    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener('click', closeContextMenu);
    return () => window.removeEventListener('click', closeContextMenu);
  }, []);

  const handleConnect = (connId) => {
    setConnectedId(connId);
    setTreeData({ databases: [], tables: {}, fields: {}, tags: {} });
    setExpandedNodes({});
    setLoadingNodes({});
    setActiveDatabase('');
    setActiveMeasurement('');
    setTabs([]);
    setActiveTabId('');
    setSqlTabCount(1);
    loadDatabases(connId);
  };

  const handleDisconnect = () => {
    setConnectedId('');
    setTreeData({ databases: [], tables: {}, fields: {}, tags: {} });
    setExpandedNodes({});
    setLoadingNodes({});
    setTabs([]);
    setActiveTabId('');
  };



  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const formatFriendlyError = (err) => {
    if (!err) return '';
    let msg = typeof err === 'string' ? err : (err.message || String(err));
    if (msg.includes("Flux query service disabled") || msg.includes("flux-enabled=true")) {
      msg += "\n\n💡 Tip: If you are connecting to InfluxDB v1.x, please verify that the 'Database Version' dropdown is set to 'InfluxDB v1'.";
    } else if (msg.includes("context deadline exceeded") || msg.includes("timeout")) {
      msg += "\n\n💡 Tip: The request timed out. Try increasing the 'Timeout (sec)' value in the connection profile settings and verify that the database server is responsive.";
    }
    return msg;
  };

  function showNotification(type, text) {
    const formatted = type === 'error' ? formatFriendlyError(text) : text;
    setNotification({ type, text: formatted });
  }

  function setDiagnosticMessage(msg) {
    setMessage(formatFriendlyError(msg));
  }

  async function callBridge(method, ...args) {
    const fn = window?.go?.main?.DesktopApp?.[method];
    if (!fn) throw new Error(`Bridge method not available: ${method}`);
    return fn(...args);
  }

  async function refreshConnections() {
    try {
      const list = await callBridge('ListConnections');
      setConnections(list || []);
      if (!selectedId && list?.length) {
        handleSelectConnection(list[0]);
      }
      if (!list || list.length === 0) {
        setShowSettings(true);
      }
    } catch (err) {
      showNotification('error', `Failed to load connections: ${err.message || err}`);
    }
  }

  async function loadQueryHistory() {
    try {
      const hist = await callBridge('GetQueryHistory');
      setQueryHistory(hist || []);
    } catch (err) {
      console.error('Failed to load query history', err);
    }
  }

  async function loadSavedQueries() {
    try {
      const sq = await callBridge('ListSavedQueries');
      setSavedQueries(sq || []);
    } catch (err) {
      console.error('Failed to load saved queries', err);
    }
  }

  async function saveQuery(tab) {
    if (!tab.query || !tab.query.trim()) return;
    try {
      const q = {
        id: `sq-${Date.now()}`,
        name: `Query ${new Date().toLocaleString()}`,
        connectionId: selected?.id || '',
        database: tab.db || '',
        statement: tab.query
      };
      await callBridge('SaveQuery', q);
      showNotification('success', 'Query saved successfully.');
      loadSavedQueries();
    } catch (e) {
      setNotification({ type: 'error', message: `Failed to remove connection: ${e}` });
    }
  }

  async function executeSavedQuery(sq) {
    const tabId = `sql:${sqlTabCount}`;
    setSqlTabCount(prev => prev + 1);
    setTabs(prev => {
      const newTabs = [...prev, {
        id: tabId,
        type: 'sql',
        title: `SQL ${sqlTabCount}`,
        query: sq.statement,
        db: sq.database || (formDatabases.length > 0 ? formDatabases[0].name : ''),
        queryResult: null,
        loading: false,
        lastQueryId: null,
        elapsedTime: 0,
      }];
      return newTabs;
    });
    setActiveTabId(tabId);
  }

  function openTableTab(dbName, tableName) {
    const tabId = `table:${dbName}:${tableName}`;

    setTabs(prev => {
      const existing = prev.find(t => t.id === tabId);
      if (!existing) {
        const newTab = {
          id: tabId,
          title: tableName,
          type: 'table',
          db: dbName,
          table: tableName,
          queryResult: { columns: [], rows: [], count: 0 },
          loading: false,
          error: '',
          sortOrder: 'desc',
          timeRange: 'all',
          customStart: '',
          customEnd: '',
          limit: 20,
          offset: 0,
          hasMore: true,
          resolution: '1s',
        };
        setTimeout(() => fetchTablePreviewData(tabId, dbName, tableName, { offset: 0, clearExisting: true }), 50);
        return [...prev, newTab];
      }
      return prev;
    });
    setActiveTabId(tabId);
  }

  function openNewSqlTab(initialQuery = '') {
    const id = `sql-${sqlTabCount}`;
    const newTab = {
      id: id,
      title: `SQL Editor ${sqlTabCount}`,
      type: 'sql',
      query: initialQuery || (selected ? getQueryTemplate(selected.version, activeDatabase) : ''),
      queryResult: { columns: [], rows: [], count: 0 },
      lastQueryId: '',
      runningQueryId: '',
      elapsedTime: '0.0',
      error: '',
      loading: false,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(id);
    setSqlTabCount(prev => prev + 1);
  }

  function closeTab(tabId, e) {
    e.stopPropagation();
    setTabs(prev => {
      const nextTabs = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId) {
        if (nextTabs.length > 0) {
          setActiveTabId(nextTabs[nextTabs.length - 1].id);
        } else {
          setActiveTabId('');
        }
      }
      return nextTabs;
    });
  }

  function updateTabQuery(tabId, newQuery) {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, query: newQuery } : t));
  }

  async function fetchTablePreviewData(tabId, dbName, tableName, options = {}) {
    if (!selected) return;

    const currentTab = tabs.find(x => x.id === tabId);

    const sortOrder = options.hasOwnProperty('sortOrder') ? options.sortOrder : (currentTab?.sortOrder || 'desc');
    const timeRange = options.hasOwnProperty('timeRange') ? options.timeRange : (currentTab?.timeRange || 'all');
    const limit = options.hasOwnProperty('limit') ? options.limit : (currentTab?.limit || 20);
    const offset = options.hasOwnProperty('offset') ? options.offset : (currentTab?.offset || 0);
    const selectedColumns = options.hasOwnProperty('selectedColumns') ? options.selectedColumns : (currentTab?.selectedColumns || []);

    setTabs(prev => prev.map(x => x.id === tabId ? { 
      ...x, 
      loading: true, 
      error: '',
      sortOrder,
      timeRange,
      limit,
      offset,
      selectedColumns: selectedColumns.length > 0 ? selectedColumns : (currentTab?.selectedColumns || []),
    } : x));

    let finalSelectedColumns = [...selectedColumns];

    // If no columns are selected, discover the FULL schema via the adapter's
    // metadata APIs (ListFields + ListTags). This is the source of truth — it
    // does NOT depend on which row sample we get back.
    //
    // Why not `SELECT * LIMIT 1`? InfluxDB stores wide tables as multiple
    // series (one per tag combination). LIMIT 1 returns ONE row from ONE
    // series, missing columns that live in other series. For a table like
    // VIBRATION_SENSOR with 46+ fields, only the few fields present in that
    // first row would show up.
    if (finalSelectedColumns.length === 0) {
      const cacheKey = `${dbName}:${tableName}`;
      let knownFields = treeData.fields[cacheKey];
      let knownTags = treeData.tags[cacheKey];

      // Schema not cached yet — fetch it now (parallel).
      if (!knownFields || !knownTags) {
        try {
          const scope = { database: dbName, bucket: dbName, org: selected?.organization || '' };
          const [flds, tgs] = await Promise.all([
            callBridge('ListFields', selected.id, scope, tableName),
            callBridge('ListTags', selected.id, scope, tableName),
          ]);
          knownFields = flds || [];
          knownTags = tgs || [];
          setTreeData(prev => ({
            ...prev,
            fields: { ...prev.fields, [cacheKey]: knownFields },
            tags: { ...prev.tags, [cacheKey]: knownTags },
          }));
        } catch (err) {
          console.warn('Schema fetch failed, falling back to LIMIT 1 discovery', err);
        }
      }

      if ((knownFields && knownFields.length) || (knownTags && knownTags.length)) {
        // Use the full schema — every field/tag the server knows about.
        finalSelectedColumns = [
          ...(knownFields || []).map(f => f.name),
          ...(knownTags || []).map(t => t.name),
        ];
      } else {
        // Last-resort fallback: sample a wide chunk (no time filter) to
        // get as many distinct columns as possible. LIMIT 1 alone is too
        // narrow for wide tables split across many series.
        try {
          const testQuery = `SELECT * FROM "${tableName}" LIMIT 500`;
          const testRes = await callBridge('ExecuteQuery', {
            connectionId: selected.id,
            statement: testQuery,
            limit: 500,
            timeout: 30 * 1000000000,
            database: dbName,
          });
          if (testRes && testRes.columns) {
            finalSelectedColumns = testRes.columns.filter(c => c !== 'time' && c !== '_time' && c !== '_x');
          }
        } catch (err) {
          console.warn('Wide-scan discovery failed', err);
        }
      }

      if (finalSelectedColumns.length > 0) {
        setTabs(prev => prev.map(x => x.id === tabId ? { ...x, selectedColumns: finalSelectedColumns } : x));
      }
    }

    const previewQuery = getTablePreviewQuery(selected.version, dbName, tableName, sortOrder, limit, offset, timeRange, finalSelectedColumns);
    const timeoutSeconds = selected.timeoutSeconds || 30;
    const timeoutNs = timeoutSeconds * 1000000000;
    
    try {
      const res = await callBridge('ExecuteQuery', {
        connectionId: selected.id,
        statement: previewQuery,
        limit: limit,
        timeout: timeoutNs,
        database: dbName,
        // Send the canonical column list so the backend uses it as the
        // column set (stable across paginations and row subsets).
        selectedColumns: finalSelectedColumns.length > 0 ? finalSelectedColumns : undefined,
      });
      
      setTabs(prev => prev.map(t => {
        if (t.id !== tabId) return t;
        const incomingRows = res?.rows || [];
        const columns = res?.columns || [];
        
        let mergedRows = [];
        if (options.clearExisting || offset === 0) {
          mergedRows = incomingRows;
        } else {
          mergedRows = [...(t.queryResult?.rows || []), ...incomingRows];
        }

        let newRows = mergedRows;

        const hasMore = incomingRows.length >= limit;
        return {
          ...t,
          queryResult: { columns, rows: newRows, count: newRows.length },
          loading: false,
          hasMore
        };
      }));
    } catch (err) {
      setTabs(prev => prev.map(t => t.id === tabId ? { 
        ...t, 
        loading: false, 
        error: String(err.message || err) 
      } : t));
      setDiagnosticMessage(err);
      showNotification('error', err);
    }
  }

  async function runSqlTabQuery(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !selected) return;

    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, loading: true, error: '' } : t));
    
    const startTime = Date.now();
    const timerInterval = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, elapsedTime: elapsed } : t));
    }, 100);

    const timeoutSeconds = selected.timeoutSeconds || 30;
    const timeoutNs = timeoutSeconds * 1000000000;

    try {
      const queryId = await callBridge('StartQuery', { 
        connectionId: selected.id, 
        statement: tab.query, 
        limit: 1000, 
        timeout: timeoutNs,
        database: activeDatabase || (treeData.databases[0]?.name || '')
      });

      setTabs(prev => prev.map(t => t.id === tabId ? { 
        ...t, 
        runningQueryId: queryId, 
        lastQueryId: queryId 
      } : t));

      for (;;) {
        const job = await callBridge('GetQuery', queryId);
        if (job?.status === 'success') {
          clearInterval(timerInterval);
          setTabs(prev => prev.map(t => t.id === tabId ? { 
            ...t, 
            queryResult: job?.result || { columns: [], rows: [], count: 0 }, 
            loading: false,
            runningQueryId: '' 
          } : t));
          showNotification('success', `Query returned ${job?.result?.count || 0} rows in ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
          loadQueryHistory();
          break;
        }
        if (job?.status === 'cancelled') {
          clearInterval(timerInterval);
          setTabs(prev => prev.map(t => t.id === tabId ? { 
            ...t, 
            loading: false,
            runningQueryId: '' 
          } : t));
          showNotification('info', `Query execution aborted.`);
          loadQueryHistory();
          break;
        }
        if (job?.status === 'error') {
          clearInterval(timerInterval);
          setTabs(prev => prev.map(t => t.id === tabId ? { 
            ...t, 
            loading: false,
            runningQueryId: '',
            error: job?.error || 'Query failed' 
          } : t));
          setDiagnosticMessage(job?.error || 'Query failed');
          showNotification('error', job?.error || 'Query failed');
          loadQueryHistory();
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (err) {
      clearInterval(timerInterval);
      setTabs(prev => prev.map(t => t.id === tabId ? { 
        ...t, 
        loading: false,
        runningQueryId: '',
        error: String(err.message || err) 
      } : t));
      setDiagnosticMessage(err);
      showNotification('error', err);
      loadQueryHistory();
    }
  }

  async function cancelSqlTabQuery(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.runningQueryId) return;
    try {
      await callBridge('CancelQuery', tab.runningQueryId);
    } catch (err) {
      showNotification('error', `Cancel error: ${err.message || err}`);
    }
  }

  async function exportTabResult(tabId, kind) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.lastQueryId) return;
    setStatus(`Exporting ${kind.toUpperCase()}...`);
    try {
      const saved = kind === 'csv'
        ? await callBridge('ExportQueryCSV', tab.lastQueryId)
        : await callBridge('ExportQueryJSON', tab.lastQueryId);
      if (!saved) {
        setStatus('Export cancelled');
        return;
      }
      setStatus('Export complete');
      showNotification('success', `Exported to: ${saved}`);
    } catch (err) {
      setStatus('Export failed');
      showNotification('error', `Export failed: ${err.message || err}`);
    }
  }

  async function loadDatabases(connId) {
    setStatus('Loading databases...');
    try {
      const dbs = await callBridge('ListDatabases', connId);
      setTreeData(prev => ({ ...prev, databases: dbs || [] }));
      setStatus('Ready');
    } catch (err) {
      showNotification('error', `Failed to list databases: ${err.message || err}`);
      setStatus('Load failed');
    }
  }

  async function loadTables(connId, dbName) {
    const nodeId = `db:${dbName}`;
    setLoadingNodes(prev => ({ ...prev, [nodeId]: true }));
    try {
      const scope = { database: dbName, bucket: dbName, org: selected?.organization || '' };
      const list = await callBridge('ListMeasurements', connId, scope);
      setTreeData(prev => ({
        ...prev,
        tables: { ...prev.tables, [dbName]: list || [] }
      }));
    } catch (err) {
      showNotification('error', `Failed to load tables for "${dbName}": ${err.message || err}`);
    } finally {
      setLoadingNodes(prev => ({ ...prev, [nodeId]: false }));
    }
  }

  async function loadTableDetails(connId, dbName, tableName) {
    const nodeId = `table:${dbName}:${tableName}`;
    setLoadingNodes(prev => ({ ...prev, [nodeId]: true }));
    try {
      const scope = { database: dbName, bucket: dbName, org: selected?.organization || '' };
      const [flds, tgs] = await Promise.all([
        callBridge('ListFields', connId, scope, tableName),
        callBridge('ListTags', connId, scope, tableName),
      ]);
      const cacheKey = `${dbName}:${tableName}`;
      setTreeData(prev => ({
        ...prev,
        fields: { ...prev.fields, [cacheKey]: flds || [] },
        tags: { ...prev.tags, [cacheKey]: tgs || [] }
      }));
    } catch (err) {
      showNotification('error', `Failed to load details for "${tableName}": ${err.message || err}`);
    } finally {
      setLoadingNodes(prev => ({ ...prev, [nodeId]: false }));
    }
  }

  async function toggleNode(nodeId, type, meta) {
    const isExpanded = !!expandedNodes[nodeId];
    setExpandedNodes(prev => ({ ...prev, [nodeId]: !isExpanded }));

    if (!isExpanded) {
      if (type === 'database') {
        const dbName = meta.database;
        if (!treeData.tables[dbName]) {
          await loadTables(selected.id, dbName);
        }
      } else if (type === 'table') {
        const { database, table } = meta;
        const cacheKey = `${database}:${table}`;
        if (!treeData.fields[cacheKey] || !treeData.tags[cacheKey]) {
          await loadTableDetails(selected.id, database, table);
        }
      }
    }
  }

  function selectNewTable(dbName, tableName) {
    setActiveDatabase(dbName);
    setActiveMeasurement(tableName);
  }

  function handleTableDoubleClick(dbName, tableName) {
    openTableTab(dbName, tableName);
  }

  function handleSelectConnection(c) {
    setFormDatabases([]);
    setSelectedId(c.id);
    setProfile({
      id: c.id,
      name: c.name,
      version: c.version,
      url: c.url,
      username: c.username || '',
      password: c.hasPassword ? '••••••••' : '',
      token: c.hasToken ? '••••••••' : '',
      organization: c.organization || '',
      bucket: c.bucket || '',
      database: c.database || '',
      retentionPolicy: c.retentionPolicy || '',
      tlsInsecure: c.tlsInsecure,
      timeoutSeconds: c.timeoutSeconds || 30,
    });
  }

  function handleFormVersionChange(ver) {
    setFormDatabases([]);
    setProfile(p => ({
      ...p,
      version: ver,
      organization: ver === 'v2' ? p.organization : '',
      bucket: ver === 'v2' ? p.bucket : '',
      database: (ver === 'v1' || ver === 'v3') ? p.database : '',
      retentionPolicy: ver === 'v1' ? p.retentionPolicy : '',
      token: (ver === 'v2' || ver === 'v3') ? p.token : '',
      password: ver === 'v1' ? p.password : '',
      username: ver === 'v1' ? p.username : '',
    }));
  }

  async function saveConnection() {
    setStatus('Saving connection...');
    setMessage('');
    try {
      const id = profile.id || crypto.randomUUID();
      await callBridge('AddConnection', { ...profile, id });
      setSelectedId(id);
      await refreshConnections();
      setProfile((p) => ({ ...p, id }));
      setStatus('Connection saved');
      showNotification('success', `Connection "${profile.name}" stored locally.`);
    } catch (err) {
      setStatus('Save failed');
      setDiagnosticMessage(err);
      showNotification('error', err);
    }
  }

  async function testSelected() {
    if (!selected) return;
    setStatus('Testing connection...');
    setMessage('');
    try {
      await callBridge('TestConnection', selected.id);
      setStatus('Connection ok');
      showNotification('success', `Connection test succeeded for "${selected.name}"`);
      loadDatabases(selected.id);
    } catch (err) {
      setStatus('Test failed');
      setDiagnosticMessage(err);
      showNotification('error', err);
    }
  }

  async function testFormConnection() {
    if (!profile.url) {
      showNotification('error', 'Server URL is required to test.');
      return;
    }
    setStatus('Testing connection...');
    setMessage('');
    setFormDatabases([]);
    try {
      await callBridge('TestConnectionProfile', profile);
      setStatus('Connection ok');
      
      try {
        const dbs = await callBridge('ListDatabasesForProfile', profile);
        setFormDatabases(dbs || []);
        if (dbs && dbs.length > 0) {
          showNotification('success', `Connection test succeeded. Discovered ${dbs.length} database(s)/bucket(s).`);
        } else {
          showNotification('success', `Connection test succeeded for "${profile.name || 'Form Config'}"`);
        }
      } catch (dbErr) {
        console.warn("Failed to list databases for tested profile:", dbErr);
        showNotification('success', `Connection test succeeded for "${profile.name || 'Form Config'}"`);
      }

      if (profile.id) {
        loadDatabases(profile.id);
      }
    } catch (err) {
      setStatus('Test failed');
      setDiagnosticMessage(err);
      showNotification('error', err);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    setStatus('Deleting connection...');
    setMessage('');
    try {
      await callBridge('DeleteConnection', selected.id);
      setStatus('Connection deleted');
      showNotification('success', `Deleted connection "${selected.name}".`);
      setSelectedId('');
      setProfile(emptyProfile);
      await refreshConnections();
    } catch (err) {
      setStatus('Delete failed');
      setMessage(String(err.message || err));
      showNotification('error', `Delete connection failed: ${err.message || err}`);
    }
  }

  return (
    <div className="app-container">
      {/* Utility Sidebar (Leftmost, 52px width) */}
      <div className="utility-bar">
        <div className="brand-icon">VDB</div>
        <button 
          className={`utility-btn ${showSettings ? 'active' : ''}`} 
          onClick={() => setShowSettings(!showSettings)}
          title="Connection Manager"
        >
          ⚙️
        </button>
      </div>

      {/* Connections Drawer */}
      {showSettings && (
        <aside className="connections-drawer">
          <div className="brand" style={{ padding: '0 0 12px 0' }}>
            <div>
              <h1 style={{ fontSize: '1.2rem', margin: 0 }}>view-db</h1>
              <p style={{ margin: '2px 0 0', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Connection Manager</p>
            </div>
          </div>

          <section className="panel" style={{ padding: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div className="panel-title" style={{ fontSize: '0.7rem', margin: 0 }}>
                {profile.id ? `Edit: ${profile.name}` : 'Add New Connection'}
              </div>
              {profile.id && (
                <button 
                  className="primary-btn" 
                  style={{ padding: '4px 8px', fontSize: '0.65rem', background: 'var(--accent-cyan)' }} 
                  onClick={() => {
                    setProfile(emptyProfile);
                    setSelectedId('');
                  }}
                >
                  ➕ New
                </button>
              )}
            </div>
            <div className="form-grid" style={{ gap: 8 }}>
              <div>
                <label style={{ fontSize: '0.65rem' }}>Connection Name</label>
                <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="Production DB" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
              </div>
              
              <div className="form-grid-row" style={{ gap: 8 }}>
                <div>
                  <label style={{ fontSize: '0.65rem' }}>Version</label>
                  <select style={{ padding: '8px 10px', fontSize: '0.8rem' }} value={profile.version} onChange={(e) => handleFormVersionChange(e.target.value)}>
                    <option value="v1">v1 (InfluxQL)</option>
                    <option value="v2">v2 (Flux)</option>
                    <option value="v3">v3 (SQL)</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem' }}>Timeout (s)</label>
                  <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} type="number" placeholder="30" value={profile.timeoutSeconds} onChange={(e) => setProfile({ ...profile, timeoutSeconds: parseInt(e.target.value) || 30 })} />
                </div>
              </div>

              <div>
                <label style={{ fontSize: '0.65rem' }}>Host / IP URL</label>
                <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="http://localhost:8086" value={profile.url} onChange={(e) => setProfile({ ...profile, url: e.target.value })} />
              </div>

              {profile.version === 'v1' && (
                <>
                  <div className="form-grid-row" style={{ gap: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Database (Opt)</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="telemetry" value={profile.database} onChange={(e) => setProfile({ ...profile, database: e.target.value })} />
                      {formDatabases.length > 0 && (
                        <select 
                          style={{ marginTop: 4, fontSize: '0.75rem', padding: '4px 6px' }}
                          value={profile.database} 
                          onChange={(e) => setProfile({ ...profile, database: e.target.value })}
                        >
                          <option value="">-- Discovered --</option>
                          {formDatabases.map(db => (
                            <option key={db.name} value={db.name}>{db.name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Retention</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="autogen" value={profile.retentionPolicy} onChange={(e) => setProfile({ ...profile, retentionPolicy: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-grid-row" style={{ gap: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Username</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="admin" value={profile.username} onChange={(e) => setProfile({ ...profile, username: e.target.value })} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Password</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} type="password" autoComplete="new-password" placeholder="••••••••" value={profile.password} onChange={(e) => setProfile({ ...profile, password: e.target.value })} />
                    </div>
                  </div>
                </>
              )}

              {profile.version === 'v2' && (
                <>
                  <div className="form-grid-row" style={{ gap: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Organization</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="my-org" value={profile.organization} onChange={(e) => setProfile({ ...profile, organization: e.target.value })} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Bucket</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="sensors" value={profile.bucket} onChange={(e) => setProfile({ ...profile, bucket: e.target.value })} />
                      {formDatabases.length > 0 && (
                        <select 
                          style={{ marginTop: 4, fontSize: '0.75rem', padding: '4px 6px' }}
                          value={profile.bucket} 
                          onChange={(e) => setProfile({ ...profile, bucket: e.target.value })}
                        >
                          <option value="">-- Discovered --</option>
                          {formDatabases.map(db => (
                            <option key={db.name} value={db.name}>{db.name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: '0.65rem' }}>Token</label>
                    <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} type="password" autoComplete="new-password" placeholder="Token string" value={profile.token} onChange={(e) => setProfile({ ...profile, token: e.target.value })} />
                  </div>
                </>
              )}

              {profile.version === 'v3' && (
                <>
                  <div>
                    <label style={{ fontSize: '0.65rem' }}>Database Name</label>
                    <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="e.g. production (Required)" value={profile.database} onChange={(e) => setProfile({ ...profile, database: e.target.value })} />
                    {formDatabases.length > 0 && (
                      <select 
                        style={{ marginTop: 4, fontSize: '0.75rem', padding: '4px 6px' }}
                        value={profile.database} 
                        onChange={(e) => setProfile({ ...profile, database: e.target.value })}
                      >
                        <option value="">-- Discovered --</option>
                        {formDatabases.map(db => (
                          <option key={db.name} value={db.name}>{db.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label style={{ fontSize: '0.65rem' }}>Token (Optional)</label>
                    <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} type="password" autoComplete="new-password" placeholder="Token string" value={profile.token} onChange={(e) => setProfile({ ...profile, token: e.target.value })} />
                  </div>
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0' }}>
                <input type="checkbox" id="tls" checked={profile.tlsInsecure} onChange={(e) => setProfile({ ...profile, tlsInsecure: e.target.checked })} />
                <label htmlFor="tls" style={{ margin: 0, cursor: 'pointer', fontSize: '0.75rem' }}>Skip TLS Verification</label>
              </div>
            </div>
            <div className="stack-actions" style={{ gap: 6, marginTop: 12 }}>
              <button className="primary-btn" style={{ flex: 1, padding: '8px 12px', fontSize: '0.8rem' }} onClick={saveConnection}>Save</button>
              <button className="ghost-btn" style={{ padding: '8px 12px', fontSize: '0.8rem' }} onClick={testFormConnection}>Test</button>
              <button className="ghost-btn" style={{ padding: '8px 12px', fontSize: '0.8rem' }} onClick={() => { setProfile(emptyProfile); setSelectedId(''); }}>Clear Form</button>
            </div>
            {selected && (
              <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                <button className="ghost-btn" style={{ flex: 1, padding: '6px 10px', fontSize: '0.75rem' }} onClick={testSelected}>Test Selected</button>
                <button className="danger-btn ghost-btn" style={{ flex: 1, padding: '6px 10px', fontSize: '0.75rem' }} onClick={deleteSelected}>Remove</button>
              </div>
            )}
          </section>
        </aside>
      )}

      {/* Main Explorer Workspace */}
      <main className="main-explorer">
        {/* Left Column: Database Navigator Tree (width 300px) */}
        <aside className="navigator-sidebar">
          <div className="navigator-sidebar-title" style={{ marginTop: 10 }}>Profiles</div>
          <div className="connection-list" style={{ maxHeight: '250px', marginBottom: 16 }}>
            {connections.map((c) => (
              <button 
                key={c.id} 
                className={`connection-card ${c.id === selectedId ? 'active' : ''}`} 
                onClick={() => handleSelectConnection(c)}
                onDoubleClick={() => handleConnect(c.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (connectedId === c.id) {
                    setContextMenu({ x: e.pageX, y: e.pageY, connId: c.id });
                  }
                }}
                style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column' }}
              >
                <div className="connection-card-info" style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                  <div>
                    <strong style={{ fontSize: '0.8rem' }}>{c.name}</strong>
                    <span style={{ fontSize: '0.65rem', display: 'block', color: 'var(--text-muted)' }}>{c.url}</span>
                  </div>
                  {connectedId === c.id && (
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--success-color)', alignSelf: 'center' }} title="Connected"></div>
                  )}
                </div>
              </button>
            ))}
            {connections.length === 0 && (
              <div style={{ padding: 8, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                No connection profiles.
              </div>
            )}
          </div>

          <div className="navigator-sidebar-title">Database Navigator</div>
          {!connectedId ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: '1.5' }}>
              <div style={{ fontSize: '2rem', marginBottom: '10px' }}>🔌</div>
              Double-click a profile above to connect and load databases.
            </div>
          ) : (
          <div className="navigator-tree-wrap">
            {treeData.databases.map(db => {
              const dbNodeId = `db:${db.name}`;
              const isDbExpanded = !!expandedNodes[dbNodeId];
              const isDbLoading = !!loadingNodes[dbNodeId];
              const tables = treeData.tables[db.name] || [];

              return (
                <div key={db.name} className="tree-node database-node">
                  <div className="tree-node-header" onClick={() => toggleNode(dbNodeId, 'database', { database: db.name })}>
                    <span className="tree-arrow">{isDbExpanded ? '▼' : '▶'}</span>
                    <span className="tree-icon">🗄️</span>
                    <span className="tree-label">{db.name}</span>
                    {isDbLoading && <span className="tree-spinner"></span>}
                  </div>
                  
                  {isDbExpanded && (
                    <div className="tree-node-children">
                      {isDbLoading && tables.length === 0 ? (
                        <div className="tree-placeholder">Loading tables...</div>
                      ) : (
                        <>
                          {tables.map(tbl => {
                            const tblNodeId = `table:${db.name}:${tbl.name}`;
                            const isTblExpanded = !!expandedNodes[tblNodeId];
                            const isTblLoading = !!loadingNodes[tblNodeId];
                            const isSelected = activeDatabase === db.name && activeMeasurement === tbl.name;
                            const cacheKey = `${db.name}:${tbl.name}`;
                            const fieldsList = treeData.fields[cacheKey] || [];
                            const tagsList = treeData.tags[cacheKey] || [];

                            return (
                              <div key={tbl.name} className={`tree-node table-node ${isSelected ? 'selected' : ''}`}>
                                <div 
                                  className="tree-node-header" 
                                  onClick={() => {
                                    selectNewTable(db.name, tbl.name);
                                    // Removed toggleNode to prevent automatic slow schema fetch
                                  }}
                                  onDoubleClick={() => handleTableDoubleClick(db.name, tbl.name)}
                                >
                                  <span 
                                    className="tree-arrow"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleNode(tblNodeId, 'table', { database: db.name, table: tbl.name });
                                    }}
                                  >
                                    {isTblExpanded ? '▼' : '▶'}
                                  </span>
                                  <span className="tree-icon">📊</span>
                                  <span className="tree-label">{tbl.name}</span>
                                  {isTblLoading && <span className="tree-spinner"></span>}
                                </div>

                                {isTblExpanded && (
                                  <div className="tree-node-children">
                                    {/* Fields */}
                                    <div className="tree-node folder-node">
                                      <div className="tree-node-header" style={{ cursor: 'default' }}>
                                        <span className="tree-icon" style={{ marginLeft: 6 }}>⊞</span>
                                        <span className="tree-label">Fields ({fieldsList.length})</span>
                                      </div>
                                      {fieldsList.length > 0 && (
                                        <div className="tree-node-children">
                                          {fieldsList.map(f => (
                                            <div key={f.name} className="tree-node-leaf">
                                              <span className="tree-icon">🔑</span>
                                              <span className="tree-label">{f.name} <small style={{ color: 'var(--accent-cyan)' }}>({f.type || 'unknown'})</small></span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>

                                    {/* Tags */}
                                    <div className="tree-node folder-node">
                                      <div className="tree-node-header" style={{ cursor: 'default' }}>
                                        <span className="tree-icon" style={{ marginLeft: 6 }}>🏷️</span>
                                        <span className="tree-label">Tags ({tagsList.length})</span>
                                      </div>
                                      {tagsList.length > 0 && (
                                        <div className="tree-node-children">
                                          {tagsList.map(t => (
                                            <div key={t.name} className="tree-node-leaf">
                                              <span className="tree-icon">🏷️</span>
                                              <span className="tree-label">{t.name}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {tables.length === 0 && !isDbLoading && (
                            <div className="tree-placeholder">No tables found.</div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {treeData.databases.length === 0 && connectedId && (
              <div className="tree-placeholder" style={{ padding: '20px 0', textAlign: 'center' }}>
                No databases found in this connection.
              </div>
            )}
          </div>
          )}

          
          <div className="navigator-sidebar-title" style={{ marginTop: 20 }}>Saved Queries</div>
          <div className="navigator-tree-wrap" style={{ maxHeight: '150px' }}>
            {savedQueries.length === 0 ? (
               <div className="tree-placeholder" style={{ padding: '10px', textAlign: 'center' }}>No saved queries.</div>
            ) : (
              savedQueries.map(sq => (
                <div key={sq.id} className="tree-node-leaf" style={{ cursor: 'pointer', padding: '4px 8px' }} onClick={() => executeSavedQuery(sq)}>
                  <span className="tree-icon">💾</span>
                  <span className="tree-label" title={sq.statement}>{sq.name}</span>
                </div>
              ))
            )}
          </div>

          <div className="navigator-sidebar-title" style={{ marginTop: 20 }}>Query History</div>
          <div className="navigator-tree-wrap" style={{ maxHeight: '150px' }}>
            {queryHistory.length === 0 ? (
               <div className="tree-placeholder" style={{ padding: '10px', textAlign: 'center' }}>No history yet.</div>
            ) : (
              queryHistory.map(qh => (
                <div key={qh.id} className="tree-node-leaf" style={{ cursor: 'pointer', padding: '4px 8px' }} onClick={() => executeSavedQuery({ statement: qh.statement, database: qh.database })}>
                  <span className="tree-icon">{qh.status === 'success' ? '✅' : '❌'}</span>
                  <span className="tree-label" title={qh.statement}>{qh.statement}</span>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Right Column: Query Workspace Tabs Area */}
        <div className="query-workspace" style={{ padding: 0, gap: 0 }}>
          {/* Workspace Tabs Bar */}
          <div className="workspace-tabs-bar">
            {tabs.map(tab => (
              <button 
                key={tab.id}
                className={`workspace-tab-btn ${activeTabId === tab.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setActiveDatabase(tab.db || activeDatabase);
                  setActiveMeasurement(tab.table || activeMeasurement);
                }}
              >
                <span>{tab.type === 'table' ? '📊' : '⚡'} {tab.title}</span>
                <span className="workspace-tab-close" onClick={(e) => closeTab(tab.id, e)}>✕</span>
              </button>
            ))}
            <button className="workspace-tab-add-btn" onClick={() => openNewSqlTab()} title="New SQL Editor">+</button>
          </div>

          {/* Active Tab Content Pane */}
          <div className="workspace-active-content-pane">
            {notification && (
              <div className={`notification-banner notification-${notification.type}`} style={{ top: 60 }}>
                <span>{notification.text}</span>
                <button 
                  onClick={() => setNotification(null)} 
                  style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  ✕
                </button>
              </div>
            )}

            {message && (
              <section className="panel" style={{ margin: '16px 16px 0 16px', borderColor: 'var(--accent-rose)', color: '#fda4af', fontSize: '0.85rem', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', padding: 12 }}>
                <strong>Logs & Diagnostics:</strong>
                <div style={{ marginTop: 8 }}>{message}</div>
              </section>
            )}

            {(() => {
              const activeTab = tabs.find(t => t.id === activeTabId);
              if (!activeTab) {
                return (
                  <div className="details-empty" style={{ flex: 1 }}>
                    <span style={{ fontSize: '2.5rem', marginBottom: 12 }}>⚡</span>
                    <h3>No Active Tab</h3>
                    <p style={{ maxWidth: 360, margin: '8px auto 0' }}>
                      Double-click a table in the Database Navigator tree on the left to explore its data, or click the <strong>+</strong> button to open a new SQL editor tab.
                    </p>
                  </div>
                );
              }

              if (activeTab.type === 'table') {
                return (
                  <TableTabContent 
                    tab={activeTab}
                    treeData={treeData}
                    fetchTablePreviewData={fetchTablePreviewData}
                    selectedConnection={selected}
                    exportTabResult={exportTabResult}
                  />
                );
              } else {
                return (
                  <SqlTabContent 
                    key={activeTab.id}
                    tab={activeTab}
                    runSqlTabQuery={runSqlTabQuery}
                    cancelSqlTabQuery={cancelSqlTabQuery}
                    updateTabQuery={updateTabQuery}
                    exportTabResult={exportTabResult}
                  />
                );
              }
            })()}
          </div>
        </div>
      </main>

      {/* Context Menu */}
      {contextMenu && (
        <div 
          style={{ 
            position: 'absolute', 
            left: contextMenu.x, 
            top: contextMenu.y, 
            background: 'var(--bg-lighter)', 
            border: '1px solid var(--border-color)', 
            padding: '4px', 
            borderRadius: '4px', 
            zIndex: 9999, 
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)' 
          }}
        >
          <button 
            className="danger-btn ghost-btn" 
            style={{ width: '100%', textAlign: 'left', padding: '6px 16px', fontSize: '0.8rem', border: 'none', background: 'transparent' }} 
            onClick={(e) => {
              e.stopPropagation();
              handleDisconnect();
              setContextMenu(null);
            }}
          >
            🔌 Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
