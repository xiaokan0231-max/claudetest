import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { assertSqlIdentifier } from "./config.js";
import { toMysqlDateTime } from "./utils.js";

function baseOptions(connection) {
  return {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    charset: "utf8mb4",
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  };
}

export function createAppPool(config) {
  return mysql.createPool({
    ...baseOptions(config.db),
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });
}

export function createAdminConnection(config) {
  return mysql.createConnection({
    ...baseOptions(config.adminDb),
    multipleStatements: true,
  });
}

async function tableExists(connection, database, table) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = ? AND table_name = ?
     LIMIT 1`,
    [database, table],
  );
  return rows.length > 0;
}

async function ensureColumn(connection, database, table, column, definition) {
  if (!(await tableExists(connection, database, table))) {
    return;
  }
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ?
     LIMIT 1`,
    [database, table, column],
  );
  if (rows.length === 0) {
    await connection.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
    );
  }
}

async function ensureIndex(connection, database, table, index, definition) {
  if (!(await tableExists(connection, database, table))) {
    return;
  }
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND index_name = ?
     LIMIT 1`,
    [database, table, index],
  );
  if (rows.length === 0) {
    await connection.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  }
}

async function ensurePrimaryKey(connection, database, table, columns) {
  if (!(await tableExists(connection, database, table))) {
    return;
  }
  const [rows] = await connection.execute(
    `SELECT column_name
     FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND index_name = 'PRIMARY'
     ORDER BY seq_in_index`,
    [database, table],
  );
  const current = rows.map((row) => row.column_name);
  if (current.join(",") === columns.join(",")) {
    return;
  }
  const definition = columns.map((column) => `\`${column}\``).join(", ");
  if (current.length > 0) {
    await connection.query(
      `ALTER TABLE \`${table}\` DROP PRIMARY KEY, ADD PRIMARY KEY (${definition})`,
    );
  } else {
    await connection.query(
      `ALTER TABLE \`${table}\` ADD PRIMARY KEY (${definition})`,
    );
  }
}

async function ensureForeignKey(
  connection,
  database,
  table,
  constraint,
  definition,
) {
  if (!(await tableExists(connection, database, table))) {
    return;
  }
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.referential_constraints
     WHERE constraint_schema = ? AND table_name = ? AND constraint_name = ?
     LIMIT 1`,
    [database, table, constraint],
  );
  if (rows.length === 0) {
    await connection.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  }
}

async function migrateExistingSchema(connection, database) {
  await ensureColumn(
    connection,
    database,
    "tracked_queries",
    "archived_at",
    "DATETIME(6) NULL AFTER `enabled`",
  );
  await ensureColumn(
    connection,
    database,
    "collection_batches",
    "request_id",
    "VARCHAR(64) NULL AFTER `actual_quota_units`",
  );
  await ensureColumn(
    connection,
    database,
    "posts",
    "thumbnail_url",
    "VARCHAR(2048) NULL AFTER `url`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_runs",
    "trigger_type",
    "VARCHAR(32) NOT NULL DEFAULT 'manual' AFTER `status`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_runs",
    "source_batch_id",
    "BIGINT UNSIGNED NULL AFTER `trigger_type`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_runs",
    "request_id",
    "VARCHAR(64) NULL AFTER `source_batch_id`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_runs",
    "summary_json",
    "JSON NULL AFTER `parameters_json`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_runs",
    "report_markdown_ja",
    "LONGTEXT NULL AFTER `report_markdown`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_comment_terms",
    "dimension_type",
    "VARCHAR(32) NOT NULL DEFAULT 'overall' AFTER `analysis_run_id`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_comment_terms",
    "dimension_value",
    "VARCHAR(191) NOT NULL DEFAULT 'ALL' AFTER `dimension_type`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_comment_terms",
    "sentiment_label",
    "VARCHAR(16) NOT NULL DEFAULT 'all' AFTER `dimension_value`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_comment_terms",
    "share_pct",
    "DECIMAL(18,6) NULL AFTER `count`",
  );
  await ensureColumn(
    connection,
    database,
    "analysis_comment_terms",
    "lift_score",
    "DECIMAL(18,6) NULL AFTER `share_pct`",
  );
  if (await tableExists(connection, database, "analysis_comment_terms")) {
    await connection.query(
      "ALTER TABLE `analysis_comment_terms` MODIFY `dimension_value` VARCHAR(191) NOT NULL, MODIFY `term` VARCHAR(255) COLLATE utf8mb4_bin NOT NULL",
    );
  }
  await ensureIndex(
    connection,
    database,
    "collection_batches",
    "uq_collection_batches_request_id",
    "UNIQUE KEY `uq_collection_batches_request_id` (`request_id`)",
  );
  await ensureIndex(
    connection,
    database,
    "analysis_runs",
    "idx_analysis_runs_source_batch_id",
    "KEY `idx_analysis_runs_source_batch_id` (`source_batch_id`)",
  );
  await ensureIndex(
    connection,
    database,
    "analysis_runs",
    "uq_analysis_runs_request_id",
    "UNIQUE KEY `uq_analysis_runs_request_id` (`request_id`)",
  );
  await ensureForeignKey(
    connection,
    database,
    "analysis_runs",
    "fk_analysis_runs_source_batch",
    "CONSTRAINT `fk_analysis_runs_source_batch` FOREIGN KEY (`source_batch_id`) REFERENCES `collection_batches` (`id`) ON DELETE SET NULL",
  );
  await ensurePrimaryKey(connection, database, "analysis_comment_terms", [
    "analysis_run_id",
    "dimension_type",
    "dimension_value",
    "sentiment_label",
    "term_type",
    "term",
  ]);
  await ensureIndex(
    connection,
    database,
    "keyword_candidates",
    "idx_keyword_candidates_status_score",
    "KEY `idx_keyword_candidates_status_score` (`status`, `total_score`)",
  );
}

export async function initDatabase(config) {
  const database = assertSqlIdentifier(config.db.database, "MYSQL_DATABASE");
  const user = assertSqlIdentifier(config.db.user, "MYSQL_USER");
  const connection = await createAdminConnection(config);
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await connection.query(`USE \`${database}\``);
    await migrateExistingSchema(connection, database);

    const account = `${connection.escape(user)}@'localhost'`;
    const password = connection.escape(config.db.password);
    await connection.query(
      `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${password}`,
    );
    await connection.query(`ALTER USER ${account} IDENTIFIED BY ${password}`);

    const schemaPath = path.join(config.projectRoot, "sql", "schema.sql");
    const schema = await fs.readFile(schemaPath, "utf8");
    await connection.query(schema);
    await connection.query(
      `INSERT IGNORE INTO collection_quota_usage
        (batch_id, quota_bucket, estimated_units, actual_units)
       SELECT id, 'standard_units_per_day', estimated_quota_units, actual_quota_units
       FROM collection_batches`,
    );
    await connection.query(
      `INSERT IGNORE INTO collection_quota_usage
        (batch_id, quota_bucket, estimated_units, actual_units)
       SELECT b.id, 'search_requests_per_day',
              COALESCE(SUM(CASE WHEN r.run_type = 'query_search' THEN r.request_count ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN r.run_type = 'query_search' THEN r.request_count ELSE 0 END), 0)
       FROM collection_batches b
       LEFT JOIN collection_runs r ON r.batch_id = b.id
       GROUP BY b.id`,
    );
    await connection.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO ${account}`,
    );
    await connection.query("FLUSH PRIVILEGES");
  } finally {
    await connection.end();
  }

  const pool = createAppPool(config);
  try {
    const seeds = [
      ["生成AI", "生成AI", "生成AI"],
      ["AIニュース", "AIニュース", "AIニュース"],
      ["データエンジニア", "データエンジニア", "データエンジニア"],
    ];
    for (const [name, queryText, topic] of seeds) {
      await pool.execute(
        `INSERT INTO tracked_queries
          (name, query_text, topic, region_code, relevance_language, safe_search, max_results, lookback_days, enabled)
         VALUES (?, ?, ?, 'JP', 'ja', 'moderate', 50, 7, TRUE)
         ON DUPLICATE KEY UPDATE
          query_text = VALUES(query_text),
          topic = VALUES(topic),
          region_code = VALUES(region_code),
          relevance_language = VALUES(relevance_language),
          safe_search = VALUES(safe_search),
          max_results = VALUES(max_results),
          lookback_days = VALUES(lookback_days),
          enabled = TRUE,
          archived_at = NULL`,
        [name, queryText, topic],
      );
    }
  } finally {
    await pool.end();
  }
}

export async function withTransaction(pool, callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function withAdvisoryLock(pool, lockName, callback) {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [lockName],
    );
    if (Number(rows[0]?.acquired) !== 1) {
      const error = new Error(`Another ${lockName} operation is already running`);
      error.code = "OPERATION_CONFLICT";
      throw error;
    }
    return await callback();
  } finally {
    try {
      await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    } catch {
      // The connection may already be closed after a database failure.
    }
    connection.release();
  }
}

export async function createCollectionBatch(
  pool,
  { observedAt, triggerType, estimatedQuotaUnits, requestId = null },
) {
  const timestamp = toMysqlDateTime(observedAt);
  const [result] = await pool.execute(
    `INSERT INTO collection_batches
      (started_at, observed_at, trigger_type, status, estimated_quota_units,
       request_id)
     VALUES (?, ?, ?, 'running', ?, ?)`,
    [timestamp, timestamp, triggerType, estimatedQuotaUnits, requestId],
  );
  return result.insertId;
}

// Reap orphaned 'running' batches left by a crashed/killed collection. Safe to
// call only while holding the collect advisory lock: the lock guarantees no other
// collection is in flight, so any still-'running' batch is a zombie. Returns the
// number of batches reaped. Without this, a SIGKILL mid-run leaves a permanent
// 'running' row that misleads dashboards and freshness/quota views.
export async function reapStaleRunningBatches(pool) {
  const [result] = await pool.execute(
    `UPDATE collection_batches
     SET completed_at = ?, status = 'failed',
         error_summary = 'reaped: orphaned running batch (process restart)'
     WHERE status = 'running'`,
    [toMysqlDateTime(new Date())],
  );
  return result.affectedRows ?? 0;
}

export async function finishCollectionBatch(
  pool,
  batchId,
  { status, actualQuotaUnits, errorSummary = null },
) {
  await pool.execute(
    `UPDATE collection_batches
     SET completed_at = ?, status = ?, actual_quota_units = ?, error_summary = ?
     WHERE id = ?`,
    [
      toMysqlDateTime(new Date()),
      status,
      actualQuotaUnits,
      errorSummary,
      batchId,
    ],
  );
}

export async function recordCollectionRun(
  pool,
  {
    batchId,
    queryId = null,
    runType,
    startedAt,
    status,
    requestCount,
    returnedCount,
    quotaUnits,
    errorSummary = null,
  },
) {
  await pool.execute(
    `INSERT INTO collection_runs
      (batch_id, query_id, run_type, started_at, completed_at, status,
       request_count, returned_count, quota_units, error_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      batchId,
      queryId,
      runType,
      toMysqlDateTime(startedAt),
      toMysqlDateTime(new Date()),
      status,
      requestCount,
      returnedCount,
      quotaUnits,
      errorSummary,
    ],
  );
}

export async function recordCollectionQuotaUsage(
  pool,
  batchId,
  estimatedByBucket,
  actualByBucket,
) {
  const buckets = new Set([
    ...Object.keys(estimatedByBucket ?? {}),
    ...Object.keys(actualByBucket ?? {}),
  ]);
  for (const bucket of buckets) {
    await pool.execute(
      `INSERT INTO collection_quota_usage
        (batch_id, quota_bucket, estimated_units, actual_units)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        estimated_units = VALUES(estimated_units),
        actual_units = VALUES(actual_units)`,
      [
        batchId,
        bucket,
        Number(estimatedByBucket?.[bucket] ?? 0),
        Number(actualByBucket?.[bucket] ?? 0),
      ],
    );
  }
}
