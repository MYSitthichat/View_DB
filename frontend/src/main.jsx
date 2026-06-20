import React, { useEffect, useMemo, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

import { emptyProfile } from './lib/profile.js';
import {
  getQueryTemplate,
  getTablePreviewQuery,
} from './lib/queries.js';
import { AppErrorBoundary } from './components/AppErrorBoundary.jsx';
import { TableTabContent } from './components/TableTab.jsx';
import { SqlTabContent } from './components/SqlTab.jsx';
import { callBridge } from './hooks/useBridge.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';

function formatFriendlyError(err) {
  if (!err) return '';
  let msg = typeof err === 'string' ? err : (err.message || String(err));
  if (msg.includes('Flux query service disabled') || msg.includes('flux-enabled=true')) {
    msg += "\n\n💡 Tip: If you are connecting to InfluxDB v1.x, please verify that the 'Database Version' dropdown is set to 'InfluxDB v1'.";
  } else if (msg.includes('context deadline exceeded') || msg.includes('timeout')) {
    msg += "\n\n💡 Tip: The request timed out. Try increasing the 'Timeout (sec)' value in the connection profile settings and verify that the database server is responsive.";
  }
  return msg;
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

  const selected = useMemo(
    () => connections.find((c) => c.id === selectedId) || null,
    [connections, selectedId]
  );

  useEffect(() => {
    refreshConnections();
    loadSavedQueries();
    loadQueryHistory();
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener('click', closeContextMenu);
    return () => window.removeEventListener('click', closeContextMenu);
  }, []);

  // Global keyboard shortcuts (Ctrl+Enter, Ctrl+S, Ctrl+K/J, Esc).
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeTabIsSql = activeTab?.type === 'sql';
  const shortcutHandlers = useMemo(() => ({
    runQuery: () => { if (activeTabIsSql) runSqlTabQuery(activeTabId); },
    saveQuery: () => { if (activeTabIsSql) saveQuery(activeTab); },
    nextTab: () => {
      const idx = tabs.findIndex(t => t.id === activeTabId);
      if (idx >= 0 && tabs.length > 0) {
        setActiveTabId(tabs[(idx + 1) % tabs.length].id);
      }
    },
    prevTab: () => {
      const idx = tabs.findIndex(t => t.id === activeTabId);
      if (idx >= 0 && tabs.length > 0) {
        setActiveTabId(tabs[(idx - 1 + tabs.length) % tabs.length].id);
      }
    },
    dismissNotification: () => setNotification(null),
  }), [activeTab, activeTabId, activeTabIsSql, runSqlTabQuery, saveQuery, tabs]);
  useKeyboardShortcuts(shortcutHandlers);

  function showNotification(type, text) {
    const formatted = type === 'error' ? formatFriendlyError(text) : text;
    setNotification({ type, text: formatted });
  }
  function setDiagnosticMessage(msg) {
    setMessage(formatFriendlyError(msg));
  }

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

  // ---------- bridge calls ----------

  async function refreshConnections() {
    try {
      const list = await callBridge('ListConnections');
      setConnections(list || []);
      if (!selectedId && list?.length) handleSelectConnection(list[0]);
      if (!list || list.length === 0) setShowSettings(true);
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
        statement: tab.query,
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
    setTabs(prev => [...prev, {
      id: tabId,
      type: 'sql',
      title: `SQL ${sqlTabCount}`,
      query: sq.statement,
      db: sq.database || (formDatabases.length > 0 ? formDatabases[0].name : ''),
      queryResult: null,
      loading: false,
      lastQueryId: null,
      elapsedTime: 0,
    }]);
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
      id,
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

    // Schema discovery: prefer cached fields/tags. If empty, fall back to
    // a wide LIMIT 500 sample so VIBRATION_SENSOR-style wide tables still
    // expose all columns even when ListFields returned nothing (V2 last hour).
    if (finalSelectedColumns.length === 0) {
      const cacheKey = `${dbName}:${tableName}`;
      let knownFields = treeData.fields[cacheKey];
      let knownTags = treeData.tags[cacheKey];

      if (!knownFields || !knownTags) {
        try {
          const scope = { database: dbName, bucket: dbName, org: selected?.organization || '' };
          const [flds, tgs] = await Promise.all([
            callBridge('ListFields', selected.id, scope, tableName),
            callBridge('ListTags',   selected.id, scope, tableName),
          ]);
          knownFields = flds || [];
          knownTags = tgs || [];
          setTreeData(prev => ({
            ...prev,
            fields: { ...prev.fields, [cacheKey]: knownFields },
            tags:   { ...prev.tags,   [cacheKey]: knownTags },
          }));
        } catch (err) {
          console.warn('Schema fetch failed, falling back to LIMIT 1 discovery', err);
        }
      }

      if ((knownFields && knownFields.length) || (knownTags && knownTags.length)) {
        finalSelectedColumns = [
          ...(knownFields || []).map(f => f.name),
          ...(knownTags   || []).map(t => t.name),
        ];
      } else {
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

    const previewQuery = getTablePreviewQuery(
      selected.version, dbName, tableName, sortOrder, limit, offset, timeRange, finalSelectedColumns
    );
    const timeoutSeconds = selected.timeoutSeconds || 30;
    const timeoutNs = timeoutSeconds * 1000000000;

    try {
      const res = await callBridge('ExecuteQuery', {
        connectionId: selected.id,
        statement: previewQuery,
        limit,
        timeout: timeoutNs,
        database: dbName,
        selectedColumns: finalSelectedColumns.length > 0 ? finalSelectedColumns : undefined,
      });

      setTabs(prev => prev.map(t => {
        if (t.id !== tabId) return t;
        const incomingRows = res?.rows || [];
        const columns = res?.columns || [];

        let mergedRows;
        if (options.clearExisting || offset === 0) {
          mergedRows = incomingRows;
        } else {
          mergedRows = [...(t.queryResult?.rows || []), ...incomingRows];
        }

        const hasMore = incomingRows.length >= limit;
        return {
          ...t,
          queryResult: { columns, rows: mergedRows, count: mergedRows.length },
          loading: false,
          hasMore,
        };
      }));
    } catch (err) {
      setTabs(prev => prev.map(t => t.id === tabId ? {
        ...t,
        loading: false,
        error: String(err.message || err),
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
    // User can override via tab.limit (set by the row-count selector); fall back to 1000.
    const rowLimit = tab.sqlLimit || 1000;

    try {
      const queryId = await callBridge('StartQuery', {
        connectionId: selected.id,
        statement: tab.query,
        limit: rowLimit,
        timeout: timeoutNs,
        database: activeDatabase || (treeData.databases[0]?.name || ''),
      });

      setTabs(prev => prev.map(t => t.id === tabId ? {
        ...t,
        runningQueryId: queryId,
        lastQueryId: queryId,
      } : t));

      for (;;) {
        const job = await callBridge('GetQuery', queryId);
        if (job?.status === 'success') {
          clearInterval(timerInterval);
          setTabs(prev => prev.map(t => t.id === tabId ? {
            ...t,
            queryResult: job?.result || { columns: [], rows: [], count: 0 },
            loading: false,
            runningQueryId: '',
          } : t));
          showNotification('success', `Query returned ${job?.result?.count || 0} rows in ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
          loadQueryHistory();
          break;
        }
        if (job?.status === 'cancelled') {
          clearInterval(timerInterval);
          setTabs(prev => prev.map(t => t.id === tabId ? { ...t, loading: false, runningQueryId: '' } : t));
          showNotification('info', 'Query execution aborted.');
          loadQueryHistory();
          break;
        }
        if (job?.status === 'error') {
          clearInterval(timerInterval);
          setTabs(prev => prev.map(t => t.id === tabId ? {
            ...t,
            loading: false,
            runningQueryId: '',
            error: job?.error || 'Query failed',
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
        error: String(err.message || err),
      } : t));
      setDiagnosticMessage(err);
      showNotification('error', err);
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
      if (!saved) { setStatus('Export cancelled'); return; }
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
        tables: { ...prev.tables, [dbName]: list || [] },
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
        callBridge('ListTags',   connId, scope, tableName),
      ]);
      const cacheKey = `${dbName}:${tableName}`;
      setTreeData(prev => ({
        ...prev,
        fields: { ...prev.fields, [cacheKey]: flds || [] },
        tags:   { ...prev.tags,   [cacheKey]: tgs   || [] },
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
        if (!treeData.tables[dbName]) await loadTables(selected.id, dbName);
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
      host: c.host || '',
      port: c.port || 5432,
      sslMode: c.sslMode || 'disable',
      schema: c.schema || 'public',
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
      database: (ver === 'v1' || ver === 'v3' || ver === 'pg') ? p.database : '',
      retentionPolicy: ver === 'v1' ? p.retentionPolicy : '',
      token: (ver === 'v2' || ver === 'v3') ? p.token : '',
      password: (ver === 'v1' || ver === 'pg') ? p.password : '',
      username: (ver === 'v1' || ver === 'pg') ? p.username : '',
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
    if (profile.version !== 'pg' && !profile.url) {
      showNotification('error', 'Server URL is required to test.');
      return;
    }
    if (profile.version === 'pg') {
      if (!profile.host) { showNotification('error', 'Host is required.'); return; }
      if (!profile.username) { showNotification('error', 'Username is required.'); return; }
      if (!profile.database) { showNotification('error', 'Database is required.'); return; }
    }
    setStatus('Testing connection...');
    setMessage('');
    setFormDatabases([]);
    try {
      const payload = profile.version === 'pg' ? { ...profile, url: '' } : profile;
      await callBridge('TestConnectionProfile', payload);
      setStatus('Connection ok');
      try {
        const dbs = await callBridge('ListDatabasesForProfile', payload);
        setFormDatabases(dbs || []);
        if (dbs && dbs.length > 0) {
          showNotification('success', `Connection test succeeded. Discovered ${dbs.length} database(s)/bucket(s).`);
        } else {
          showNotification('success', `Connection test succeeded for "${profile.name || 'Form Config'}"`);
        }
      } catch (dbErr) {
        console.warn('Failed to list databases for tested profile:', dbErr);
        showNotification('success', `Connection test succeeded for "${profile.name || 'Form Config'}"`);
      }
      if (profile.id) loadDatabases(profile.id);
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

  function onResetColumns() {
    // No-op at App level — TableTab handles its own state for selectedColumns
    // via tab state. We just refresh from schema.
  }

  return (
    <div className="app-container">
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
                  onClick={() => { setProfile(emptyProfile); setSelectedId(''); }}
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
                    <option value="pg">PostgreSQL</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem' }}>Timeout (s)</label>
                  <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} type="number" placeholder="30" value={profile.timeoutSeconds} onChange={(e) => setProfile({ ...profile, timeoutSeconds: parseInt(e.target.value) || 30 })} />
                </div>
              </div>

              {profile.version !== 'pg' && (
                <div>
                  <label style={{ fontSize: '0.65rem' }}>Host / IP URL</label>
                  <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="http://localhost:8086" value={profile.url} onChange={(e) => setProfile({ ...profile, url: e.target.value })} />
                </div>
              )}

              {profile.version === 'pg' && (
                <div style={{
                  padding: '6px 10px',
                  fontSize: '0.7rem',
                  color: 'var(--text-secondary)',
                  background: 'var(--accent-cyan-glow)',
                  border: '1px dashed var(--accent-cyan)',
                  borderRadius: 4,
                }}>
                  ℹ️ PostgreSQL uses Host/Port/Database/Schema below. No URL needed.
                </div>
              )}

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

              {profile.version === 'pg' && (
                <>
                  <div className="form-grid-row" style={{ gap: 8 }}>
                    <div style={{ gridColumn: '1 / span 2' }}>
                      <label style={{ fontSize: '0.65rem' }}>Host / IP</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="127.0.0.1 or db.example.com" value={profile.host || ''} onChange={(e) => setProfile({ ...profile, host: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-grid-row" style={{ gap: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Port</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} type="number" placeholder="5432" value={profile.port || 5432} onChange={(e) => setProfile({ ...profile, port: parseInt(e.target.value) || 5432 })} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>SSL Mode</label>
                      <select style={{ padding: '8px 10px', fontSize: '0.8rem' }} value={profile.sslMode || 'disable'} onChange={(e) => setProfile({ ...profile, sslMode: e.target.value })}>
                        <option value="disable">disable</option>
                        <option value="allow">allow</option>
                        <option value="prefer">prefer</option>
                        <option value="require">require</option>
                        <option value="verify-ca">verify-ca</option>
                        <option value="verify-full">verify-full</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-grid-row" style={{ gap: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Database (Required)</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="postgres" value={profile.database || ''} onChange={(e) => setProfile({ ...profile, database: e.target.value })} />
                      {formDatabases.length > 0 && (
                        <select
                          style={{ marginTop: 4, fontSize: '0.75rem', padding: '4px 6px' }}
                          value={profile.database || ''}
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
                      <label style={{ fontSize: '0.65rem' }}>Schema</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="public" value={profile.schema || 'public'} onChange={(e) => setProfile({ ...profile, schema: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-grid-row" style={{ gap: 8 }}>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Username</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} placeholder="postgres" value={profile.username || ''} onChange={(e) => setProfile({ ...profile, username: e.target.value })} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.65rem' }}>Password</label>
                      <input style={{ padding: '8px 10px', fontSize: '0.8rem' }} type="password" autoComplete="new-password" placeholder="••••••••" value={profile.password || ''} onChange={(e) => setProfile({ ...profile, password: e.target.value })} />
                    </div>
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

      <main className="main-explorer">
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
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <strong style={{ fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</strong>
                      <span style={{ fontSize: '0.55rem', padding: '1px 5px', borderRadius: 3, background: c.version === 'pg' ? 'var(--accent-emerald-glow)' : 'var(--accent-cyan-glow)', color: c.version === 'pg' ? 'var(--accent-emerald)' : 'var(--accent-cyan)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>{c.version}</span>
                    </div>
                    <span style={{ fontSize: '0.65rem', display: 'block', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.version === 'pg'
                        ? `${c.host || '(no host)'}:${c.port || 5432}/${c.database || '?'}`
                        : c.url}
                    </span>
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

        <div className="query-workspace" style={{ padding: 0, gap: 0 }}>
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
                    exportTabResult={exportTabResult}
                    onResetColumns={onResetColumns}
                  />
                );
              }
              return (
                <SqlTabContent
                  key={activeTab.id}
                  tab={activeTab}
                  runSqlTabQuery={runSqlTabQuery}
                  cancelSqlTabQuery={cancelSqlTabQuery}
                  updateTabQuery={updateTabQuery}
                  exportTabResult={exportTabResult}
                  saveQuery={saveQuery}
                />
              );
            })()}
          </div>
        </div>
      </main>

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
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
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
