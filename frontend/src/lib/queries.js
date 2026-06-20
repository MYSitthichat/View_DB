// lib/queries.js — query string builders for table preview tabs.
// Each version has its own SQL/Flux dialect; this keeps dialect logic
// out of React components.

export function getQueryTemplate(version, databaseOrBucket, measurement = 'cpu') {
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
}

export const timeRangeInterval = (range) => {
  switch (range) {
    case '15m': return '15 minutes';
    case '1h':  return '1 hour';
    case '6h':  return '6 hours';
    case '12h': return '12 hours';
    case '24h': return '24 hours';
    case '7d':  return '7 days';
    case '30d': return '30 days';
    default:   return '1 hour';
  }
};

/**
 * Build a "table preview" query for the given connection version.
 * Returns a string that can be passed to ExecuteQuery.
 *
 *   version: 'v1' | 'v2' | 'v3' | 'pg'
 *   databaseOrBucket: target database/bucket name
 *   measurement: table or measurement name
 *   selectedColumns: canonical column list from schema (empty = all)
 */
export function getTablePreviewQuery(
  version,
  databaseOrBucket,
  measurement,
  sortOrder = 'desc',
  limit = 20,
  offset = 0,
  timeRange = 'all',
  selectedColumns = []
) {
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
  }

  if (version === 'v3') {
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
  }

  if (version === 'v1') {
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

  if (version === 'pg') {
    // PostgreSQL — no time-based WHERE; user can filter via SQL editor.
    return `SELECT * FROM "${measurement}" LIMIT ${limit} OFFSET ${offset}`;
  }

  return '';
}

/**
 * Downsample time-series rows to one row per second.
 * Picks the row with the fewest null cells per second bucket.
 * Used by ChartViewer when results have many rows.
 */
export function downsampleToOneSecond(columns, rows) {
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
}
