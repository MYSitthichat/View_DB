import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { ChartViewer } from './ChartViewer.jsx';
import { formatCell, isTimeColumn } from '../lib/format.js';
import { useVirtualWindow } from '../hooks/useVirtualWindow.js';

const ROW_INDEX_WIDTH = 56;
const COL_MIN_WIDTH = 160;
const ROW_HEIGHT_PX = 26;
const VIRTUAL_OVERSCAN = 8;
// Switch to virtual scrolling above this row count to keep the DOM small.
const VIRTUAL_THRESHOLD = 200;

/**
 * TableTab — the per-measurement view.
 * Renders Properties (schema) and Data (spreadsheet) sub-tabs.
 *
 * Stability features:
 *   - "Hide empty columns" checkbox (Phase H)
 *   - Stable React keys for rows/cells (no re-render thrash)
 *   - Computed min-width so columns never collapse
 *   - "Find column" jumps horizontally to first match
 *   - Sticky row index + sticky header (CSS in styles.css)
 *
 * Virtualization (P1#2) replaces the inline tbody render with windowed rows
 * so wide tables with 100k+ rows stay responsive.
 */
export function TableTabContent({
  tab,
  treeData,
  fetchTablePreviewData,
  exportTabResult,
  onResetColumns, // optional callback to reset selectedColumns at App level
}) {
  const [activeSubTab, setActiveSubTab] = useState('properties');
  const [viewMode, setViewMode] = useState('table');
  const [columnSearch, setColumnSearch] = useState('');
  const [hideNullColumns, setHideNullColumns] = useState(false);

  const cacheKey = `${tab.db}:${tab.table}`;
  const fields = treeData.fields[cacheKey] || [];
  const tags = treeData.tags[cacheKey] || [];
  const results = tab.queryResult || { columns: [], rows: [], count: 0 };

  const containerRef = useRef(null);

  // Min-width so columns never collapse on short values.
  const tableMinWidth = useMemo(() => {
    const colCount = Math.max(results.columns?.length || 0, 1);
    return `${ROW_INDEX_WIDTH + colCount * COL_MIN_WIDTH + 32}px`;
  }, [results.columns]);

  // Hide columns where every row on this page is null/nil.
  const visibleColumns = useMemo(() => {
    const cols = results.columns || [];
    if (!hideNullColumns) return cols;
    const hasValue = (v) => v !== null && v !== undefined && v !== '';
    return cols.filter((c) => {
      for (const row of results.rows || []) {
        if (hasValue(row[cols.indexOf(c)])) return true;
      }
      return false;
    });
  }, [results.columns, results.rows, hideNullColumns]);

  const columnIndexOf = useCallback(
    (col) => (results.columns || []).indexOf(col),
    [results.columns]
  );

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
    target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    target.classList.add('col-header-found');
    setTimeout(() => target.classList.remove('col-header-found'), 2000);
  };

  useEffect(() => {
    if (containerRef.current && tab.offset === 0) {
      containerRef.current.scrollTop = 0;
    }
  }, [tab.offset, tab.sortOrder, tab.timeRange, tab.customStart, tab.customEnd]);

  return (
    <div className="table-tab-container">
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
          <PropertiesPanel fields={fields} tags={tags} />
        ) : (
          <DataPanel
            tab={tab}
            results={results}
            visibleColumns={visibleColumns}
            tableMinWidth={tableMinWidth}
            viewMode={viewMode}
            setViewMode={setViewMode}
            columnSearch={columnSearch}
            setColumnSearch={setColumnSearch}
            hideNullColumns={hideNullColumns}
            setHideNullColumns={setHideNullColumns}
            fetchTablePreviewData={fetchTablePreviewData}
            exportTabResult={exportTabResult}
            onResetColumns={onResetColumns}
            fields={fields}
            tags={tags}
            containerRef={containerRef}
            handleFindColumn={handleFindColumn}
            columnIndexOf={columnIndexOf}
          />
        )}
      </div>
    </div>
  );
}

function PropertiesPanel({ fields, tags }) {
  const total = fields.length + tags.length;
  return (
    <div className="properties-tab-content">
      <h3 style={{ margin: '0 0 10px 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        COLUMNS ({total})
      </h3>
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
  );
}

function DataPanel(props) {
  const {
    tab, results, visibleColumns, tableMinWidth,
    viewMode, setViewMode,
    columnSearch, setColumnSearch,
    hideNullColumns, setHideNullColumns,
    fetchTablePreviewData, exportTabResult, onResetColumns,
    fields, tags, containerRef, handleFindColumn, columnIndexOf,
  } = props;

  const tabId = tab.id;
  const dbName = tab.db;
  const tableName = tab.table;
  const loading = !!tab.loading;
  const offset = tab.offset || 0;
  const limit = tab.limit || 20;

  return (
    <div className="data-tab-content">
      <FilterBar
        tab={tab}
        viewMode={viewMode}
        setViewMode={setViewMode}
        columnSearch={columnSearch}
        setColumnSearch={setColumnSearch}
        handleFindColumn={handleFindColumn}
        hideNullColumns={hideNullColumns}
        setHideNullColumns={setHideNullColumns}
        visibleColumnsCount={visibleColumns.length}
        totalColumnsCount={results.columns?.length || 0}
        loading={loading}
        results={results}
        fetchTablePreviewData={fetchTablePreviewData}
        exportTabResult={exportTabResult}
        onResetColumns={onResetColumns}
        tabId={tabId}
        dbName={dbName}
        tableName={tableName}
      />

      <div
        ref={containerRef}
        className="table-wrap spreadsheet-wrap"
        style={{ flex: 1, maxHeight: '100%', marginTop: 0, overflow: viewMode === 'chart' ? 'hidden' : 'auto' }}
      >
        {viewMode === 'table' ? (
          <TableGrid
            results={results}
            visibleColumns={visibleColumns}
            tableMinWidth={tableMinWidth}
            hideNullColumns={hideNullColumns}
            loading={loading}
            offset={offset}
            columnIndexOf={columnIndexOf}
            containerRef={containerRef}
          />
        ) : (
          <ChartViewer
            results={results}
            tab={tab}
            fetchTablePreviewData={fetchTablePreviewData}
            allFields={fields.map(f => f.name).concat(tags.map(t => t.name))}
          />
        )}
      </div>

      <GridFooter
        tab={tab}
        loading={loading}
        offset={offset}
        limit={limit}
        rowsOnPage={results.rows.length}
        fetchTablePreviewData={fetchTablePreviewData}
        tabId={tabId}
        dbName={dbName}
        tableName={tableName}
      />
    </div>
  );
}

function FilterBar({
  tab, viewMode, setViewMode, columnSearch, setColumnSearch, handleFindColumn,
  hideNullColumns, setHideNullColumns, visibleColumnsCount, totalColumnsCount,
  loading, results, fetchTablePreviewData, exportTabResult, onResetColumns,
  tabId, dbName, tableName,
}) {
  const colCount = totalColumnsCount;
  const colsLabel = hideNullColumns
    ? `${visibleColumnsCount}/${colCount} cols`
    : `${colCount} cols`;
  const colsTitle = hideNullColumns
    ? `Showing ${visibleColumnsCount} of ${colCount} columns (NULL-only columns hidden)`
    : `Showing all ${colCount} column(s)`;

  return (
    <div className="filter-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
      <span className="filter-label" style={{ marginRight: '4px' }}>Scan Window:</span>
      <select
        className="filter-select"
        value={tab.timeRange || 'all'}
        onChange={(e) => fetchTablePreviewData(tabId, dbName, tableName, {
          timeRange: e.target.value, offset: 0, clearExisting: true,
        })}
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
        onChange={(e) => fetchTablePreviewData(tabId, dbName, tableName, {
          sortOrder: e.target.value, offset: 0, clearExisting: true,
        })}
      >
        <option value="desc">⬇️ Latest (Newest first)</option>
        <option value="asc">⬆️ Oldest (Oldest first)</option>
      </select>

      <select
        className="filter-select"
        value={tab.limit || 20}
        onChange={(e) => fetchTablePreviewData(tabId, dbName, tableName, {
          limit: parseInt(e.target.value, 10), offset: 0, clearExisting: true,
        })}
      >
        {[10, 20, 30, 50, 100, 200].map(n => (
          <option key={n} value={n}>{n} rows</option>
        ))}
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
            onKeyDown={(e) => { if (e.key === 'Enter') handleFindColumn(); }}
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
          title={colsTitle}
        >
          {colsLabel}
        </span>
        <label
          title="Hide columns where every row is null/nil"
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: '0.7rem', color: 'var(--text-secondary)',
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
        <button
          className="ghost-btn"
          style={{ padding: '6px 10px', fontSize: '0.7rem' }}
          onClick={() => {
            onResetColumns && onResetColumns();
            fetchTablePreviewData(tabId, dbName, tableName, { selectedColumns: [], offset: 0, clearExisting: true });
          }}
          disabled={loading}
          title="Reset to all schema columns"
        >
          ↺ All Cols
        </button>
        <button
          className="primary-btn"
          style={{ padding: '6px 12px', fontSize: '0.75rem' }}
          onClick={() => fetchTablePreviewData(tabId, dbName, tableName, { offset: 0, clearExisting: true })}
          disabled={loading}
        >
          {loading && results.rows.length === 0 ? 'Loading...' : 'Refresh'}
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
          onClick={() => exportTabResult(tabId, 'csv')}
          disabled={!results.rows.length}
        >
          Export CSV
        </button>
        <button
          className="ghost-btn"
          style={{ padding: '6px 12px', fontSize: '0.75rem' }}
          onClick={() => exportTabResult(tabId, 'json')}
          disabled={!results.rows.length}
        >
          Export JSON
        </button>
      </div>
    </div>
  );
}

function TableGrid({ results, visibleColumns, tableMinWidth, hideNullColumns, loading, offset, columnIndexOf, containerRef }) {
  // Empty state: full DOM (cheap, no virtualisation needed).
  if (results.rows.length === 0) {
    return (
      <table style={{ minWidth: tableMinWidth }}>
        <thead>
          <tr>
            <th className="row-index-hdr">#</th>
            {visibleColumns.map(col => (
              <th key={`hdr-${col}`} className="col-data-hdr" title={col}>
                <span className="col-header-txt">{col}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={visibleColumns.length + 1} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)' }}>
              {hideNullColumns && (results.columns?.length || 0) > 0
                ? 'All columns are empty (try unchecking "ซ่อนคอลัมน์ว่าง").'
                : 'No data found. Click Refresh or check your database connection.'}
            </td>
          </tr>
          {loading && (
            <tr>
              <td colSpan={visibleColumns.length + 1} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--accent-cyan)' }}>
                Loading table data preview...
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  }

  // Virtual scrolling for large row counts.
  const useVirtual = results.rows.length > VIRTUAL_THRESHOLD;

  if (!useVirtual) {
    return (
      <table style={{ minWidth: tableMinWidth }}>
        <thead>
          <tr>
            <th className="row-index-hdr">#</th>
            {visibleColumns.map(col => (
              <th key={`hdr-${col}`} className="col-data-hdr" title={col}>
                <span className="col-header-txt">{col}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.rows.map((row, rIdx) => {
            const globalRowIdx = offset + rIdx + 1;
            return (
              <tr key={`r-${rIdx}`}>
                <td className="row-index-cell">{globalRowIdx}</td>
                {visibleColumns.map((colName) => {
                  const cIdx = columnIndexOf(colName);
                  const cell = row[cIdx];
                  const display = formatCell(cell, colName);
                  return (
                    <td
                      key={`c-${rIdx}-${cIdx}`}
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

  // Virtualised body — only render the slice that's in view.
  return (
    <VirtualTableGrid
      results={results}
      visibleColumns={visibleColumns}
      tableMinWidth={tableMinWidth}
      offset={offset}
      columnIndexOf={columnIndexOf}
      containerRef={containerRef}
    />
  );
}

function VirtualTableGrid({ results, visibleColumns, tableMinWidth, offset, columnIndexOf, containerRef }) {
  const vw = useVirtualWindow({
    rowCount: results.rows.length,
    rowHeight: ROW_HEIGHT_PX,
    overscan: VIRTUAL_OVERSCAN,
    scrollRef: containerRef,
  });
  const slice = results.rows.slice(vw.startIdx, vw.endIdx);

  return (
    <table style={{ minWidth: tableMinWidth }}>
      <thead>
        <tr>
          <th className="row-index-hdr">#</th>
          {visibleColumns.map(col => (
            <th key={`hdr-${col}`} className="col-data-hdr" title={col}>
              <span className="col-header-txt">{col}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {vw.paddingTop > 0 && (
          <tr aria-hidden="true">
            <td colSpan={visibleColumns.length + 1} style={{ padding: 0, border: 'none', height: vw.paddingTop }} />
          </tr>
        )}
        {slice.map((row, localIdx) => {
          const rIdx = vw.startIdx + localIdx;
          const globalRowIdx = offset + rIdx + 1;
          return (
            <tr key={`r-${rIdx}`}>
              <td className="row-index-cell">{globalRowIdx}</td>
              {visibleColumns.map((colName) => {
                const cIdx = columnIndexOf(colName);
                const cell = row[cIdx];
                const display = formatCell(cell, colName);
                return (
                  <td
                    key={`c-${rIdx}-${cIdx}`}
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
        {vw.paddingBottom > 0 && (
          <tr aria-hidden="true">
            <td colSpan={visibleColumns.length + 1} style={{ padding: 0, border: 'none', height: vw.paddingBottom }} />
          </tr>
        )}
      </tbody>
    </table>
  );
}

function GridFooter({ tab, loading, offset, limit, rowsOnPage, fetchTablePreviewData, tabId, dbName, tableName }) {
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  return (
    <div className="grid-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--panel-border)', background: '#05080e' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          className="ghost-btn"
          style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
          onClick={() => fetchTablePreviewData(tabId, dbName, tableName, { offset: 0, clearExisting: true })}
          disabled={loading || offset === 0}
        >
          ⏮️ First
        </button>
        <button
          className="ghost-btn"
          style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
          onClick={() => fetchTablePreviewData(tabId, dbName, tableName, { offset: prevOffset, clearExisting: true })}
          disabled={loading || offset === 0}
        >
          ◀️ Prev
        </button>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', margin: '0 4px', fontWeight: 'bold' }}>
          Page {Math.floor(offset / limit) + 1}
        </span>
        <button
          className="ghost-btn"
          style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
          onClick={() => fetchTablePreviewData(tabId, dbName, tableName, { offset: nextOffset, clearExisting: true })}
          disabled={loading || !tab.hasMore}
        >
          Next ▶️
        </button>
      </div>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
        {loading && <span>⏳ Loading...</span>}
        <span>{rowsOnPage} row(s) on page</span>
      </div>
    </div>
  );
}
