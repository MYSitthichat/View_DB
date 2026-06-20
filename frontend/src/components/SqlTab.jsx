import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { ChartViewer } from './ChartViewer.jsx';
import { formatLocalTime, isTimeColumn } from '../lib/format.js';

const ROW_INDEX_WIDTH = 56;
const COL_MIN_WIDTH = 160;

/**
 * SqlTabContent — freeform SQL editor + results grid.
 * Reused for both InfluxDB (Flux / InfluxQL / SQL) and PostgreSQL.
 * Includes the same "hide empty columns" toggle as TableTab for parity.
 */
export function SqlTabContent({ tab, runSqlTabQuery, cancelSqlTabQuery, updateTabQuery, exportTabResult, saveQuery }) {
  const results = tab.queryResult || { columns: [], rows: [], count: 0 };
  const [viewMode, setViewMode] = useState('table');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [hideNullColumns, setHideNullColumns] = useState(false);

  // Reset page to 1 whenever the result set changes.
  useEffect(() => { setPage(1); }, [results.rows]);

  const totalPages = Math.ceil((results.rows?.length || 0) / pageSize) || 1;

  const displayedRows = useMemo(() => {
    if (!results.rows) return [];
    const startIndex = (page - 1) * pageSize;
    return results.rows.slice(startIndex, startIndex + pageSize);
  }, [results.rows, page, pageSize]);

  const visibleColumns = useMemo(() => {
    const cols = results.columns || [];
    if (!hideNullColumns) return cols;
    const hasValue = (v) => v !== null && v !== undefined && v !== '';
    return cols.filter((c) => {
      const idx = cols.indexOf(c);
      for (const row of displayedRows) {
        if (hasValue(row?.[idx])) return true;
      }
      return false;
    });
  }, [results.columns, displayedRows, hideNullColumns]);

  const colCount = results.columns?.length || 0;
  const colsLabel = hideNullColumns ? `${visibleColumns.length}/${colCount} cols` : `${colCount} cols`;
  const tableMinWidth = `${ROW_INDEX_WIDTH + visibleColumns.length * COL_MIN_WIDTH + 32}px`;

  const handleEditorKeyDown = useCallback((e) => {
    // Ctrl/Cmd+Enter → run query
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!tab.runningQueryId) runSqlTabQuery(tab.id);
    }
  }, [tab.runningQueryId, tab.id, runSqlTabQuery]);

  return (
    <div className="sql-tab-container">
      <EditorPanel
        tab={tab}
        updateTabQuery={updateTabQuery}
        runSqlTabQuery={runSqlTabQuery}
        cancelSqlTabQuery={cancelSqlTabQuery}
        saveQuery={saveQuery}
        handleEditorKeyDown={handleEditorKeyDown}
      />

      <ResultsPanel
        tab={tab}
        results={results}
        viewMode={viewMode}
        setViewMode={setViewMode}
        hideNullColumns={hideNullColumns}
        setHideNullColumns={setHideNullColumns}
        visibleColumns={visibleColumns}
        tableMinWidth={tableMinWidth}
        page={page}
        setPage={setPage}
        pageSize={pageSize}
        setPageSize={setPageSize}
        totalPages={totalPages}
        displayedRows={displayedRows}
        colsLabel={colsLabel}
        exportTabResult={exportTabResult}
      />
    </div>
  );
}

function EditorPanel({ tab, updateTabQuery, runSqlTabQuery, cancelSqlTabQuery, saveQuery, handleEditorKeyDown }) {
  return (
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
        onKeyDown={handleEditorKeyDown}
        placeholder="SELECT * FROM ...   (Ctrl+Enter to run)"
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
              ▶ Run Query
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function ResultsPanel({
  tab, results, viewMode, setViewMode,
  hideNullColumns, setHideNullColumns,
  visibleColumns, tableMinWidth,
  page, setPage, pageSize, setPageSize, totalPages,
  displayedRows, colsLabel, exportTabResult,
}) {
  return (
    <section className="results panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12 }}>
      <div className="panel-title-row" style={{ marginBottom: 8 }}>
        <div className="panel-title">Query Results</div>
        <div className="result-summary">{results.count || 0} rows · {colsLabel}</div>
      </div>

      <ResultsToolbar
        viewMode={viewMode}
        setViewMode={setViewMode}
        hideNullColumns={hideNullColumns}
        setHideNullColumns={setHideNullColumns}
        tab={tab}
        exportTabResult={exportTabResult}
      />

      <div className="table-wrap spreadsheet-wrap" style={{ flex: 1, maxHeight: '100%', marginTop: 0, overflow: viewMode === 'chart' ? 'hidden' : 'auto' }}>
        {viewMode === 'table' ? (
          <SqlResultsGrid
            results={results}
            displayedRows={displayedRows}
            visibleColumns={visibleColumns}
            tableMinWidth={tableMinWidth}
            hideNullColumns={hideNullColumns}
            loading={!!tab.loading}
            page={page}
            pageSize={pageSize}
          />
        ) : (
          <ChartViewer results={results} />
        )}
      </div>

      {viewMode === 'table' && results.rows.length > 0 && (
        <ResultsFooter
          page={page}
          setPage={setPage}
          pageSize={pageSize}
          setPageSize={setPageSize}
          totalPages={totalPages}
          totalRows={results.rows.length}
        />
      )}
    </section>
  );
}

function ResultsToolbar({ viewMode, setViewMode, hideNullColumns, setHideNullColumns, tab, exportTabResult }) {
  return (
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
      <label
        title="Hide columns where every row is null/nil"
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: '0.72rem', color: 'var(--text-secondary)',
          cursor: 'pointer', userSelect: 'none',
          padding: '4px 8px', borderRadius: 4,
          background: hideNullColumns ? 'var(--accent-cyan-glow)' : 'transparent',
          border: '1px solid var(--panel-border)',
        }}
      >
        <input
          type="checkbox"
          checked={hideNullColumns}
          onChange={(e) => setHideNullColumns(e.target.checked)}
          style={{ margin: 0, cursor: 'pointer' }}
        />
        <span>ซ่อนคอลัมน์ว่าง</span>
      </label>
      <button className="ghost-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => exportTabResult(tab.id, 'csv')} disabled={!tab.lastQueryId}>Export CSV</button>
      <button className="ghost-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => exportTabResult(tab.id, 'json')} disabled={!tab.lastQueryId}>Export JSON</button>
    </div>
  );
}

function SqlResultsGrid({ results, displayedRows, visibleColumns, tableMinWidth, hideNullColumns, loading, page, pageSize }) {
  if (results.rows.length === 0) {
    return (
      <table style={{ minWidth: tableMinWidth }}>
        <thead>
          <tr>
            <th className="row-index-hdr">#</th>
            {visibleColumns.map(column => (
              <th key={`sql-hdr-${column}`} className="col-data-hdr" title={column}>
                <span className="col-header-txt">{column}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={visibleColumns.length + 1} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)' }}>
              No data loaded. Write query and run.
            </td>
          </tr>
          {loading && (
            <tr>
              <td colSpan={visibleColumns.length + 1} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--accent-cyan)' }}>
                Executing SQL query...
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  }

  return (
    <table style={{ minWidth: tableMinWidth }}>
      <thead>
        <tr>
          <th className="row-index-hdr">#</th>
          {visibleColumns.map(column => (
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
              {visibleColumns.map(colName => {
                const cols = results.columns || [];
                const cellIndex = cols.indexOf(colName);
                const cell = (row || [])[cellIndex];
                let display;
                if (cell === null || cell === undefined) {
                  display = 'null';
                } else if (isTimeColumn(colName)) {
                  display = formatLocalTime(cell);
                } else if (typeof cell === 'object') {
                  try { display = JSON.stringify(cell); } catch (_) { display = String(cell); }
                } else {
                  display = String(cell);
                }
                return (
                  <td
                    key={`sql-c-${globalIndex}-${cellIndex}`}
                    className={`cell-data ${isTimeColumn(colName) ? 'col-time' : ''}`}
                    title={display}
                  >
                    {display}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ResultsFooter({ page, setPage, pageSize, setPageSize, totalPages, totalRows }) {
  return (
    <div className="grid-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--panel-border)', background: '#05080e', marginTop: '8px', borderRadius: '4px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button className="ghost-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => setPage(1)} disabled={page === 1}>⏮️ First</button>
        <button className="ghost-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>◀️ Prev</button>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', margin: '0 4px', fontWeight: 'bold' }}>
          Page {page} of {totalPages}
        </span>
        <button className="ghost-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next ▶️</button>
        <button className="ghost-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => setPage(totalPages)} disabled={page === totalPages}>Last ⏭️</button>
      </div>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Page size:</span>
        <select
          className="filter-select"
          value={pageSize}
          onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(1); }}
          style={{ padding: '4px 8px', fontSize: '0.75rem' }}
        >
          {[50, 100, 200, 500, 1000].map(n => (
            <option key={n} value={n}>{n} rows</option>
          ))}
        </select>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          {totalRows} total row(s)
        </span>
      </div>
    </div>
  );
}
