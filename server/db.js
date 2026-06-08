import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')

import { migrateAccessGroups } from './groupsMigration.js'

export function openDatabase(dbPath = path.join(dataDir, 'cat.db')) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  migrateAccessGroups(db)
  return db
}

// ============================================================================
// 版本化数据库迁移系统
// ============================================================================

/**
 * 确保 migrations 表存在（首次迁移时创建）
 */
function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

/**
 * 获取已应用的迁移版本集合
 */
function getAppliedVersions(db) {
  ensureMigrationTable(db)
  const rows = db.prepare('SELECT version FROM migrations ORDER BY version').all()
  return new Set(rows.map((r) => r.version))
}

/**
 * 执行单个版本的迁移（如未应用）
 */
function applyMigration(db, version, fn) {
  const applied = getAppliedVersions(db)
  if (applied.has(version)) return

  fn(db)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(version, now)
  console.log(`[DB] 迁移 v${version} 已应用`)
}

/**
 * 按版本顺序执行所有迁移
 */
function runMigrations(db) {
  // v1: 核心表结构（初始版本）
  applyMigration(db, 1, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS layout_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        layout_overrides TEXT NOT NULL DEFAULT '{}',
        font_scale REAL NOT NULL DEFAULT 1,
        show_layout_boxes INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS layout_preset_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        preset_id INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (preset_id) REFERENCES layout_presets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS certificates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
        preset_id INTEGER,
        layout_overrides TEXT,
        font_scale REAL NOT NULL DEFAULT 1,
        show_layout_boxes INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (preset_id) REFERENCES layout_presets(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS certificate_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        certificate_id INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        row_data TEXT NOT NULL,
        FOREIGN KEY (certificate_id) REFERENCES certificates(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS certificate_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        certificate_id INTEGER NOT NULL,
        revision_number INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (certificate_id) REFERENCES certificates(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cert_status ON certificates(status);
      CREATE INDEX IF NOT EXISTS idx_cert_rev ON certificate_revisions(certificate_id, revision_number);

      CREATE TABLE IF NOT EXISTS svg_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        svg_content TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS table_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        columns TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS block_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        svg_template_id INTEGER NOT NULL,
        table_template_id INTEGER NOT NULL,
        layout_preset_id INTEGER NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (svg_template_id) REFERENCES svg_templates(id) ON DELETE RESTRICT,
        FOREIGN KEY (table_template_id) REFERENCES table_templates(id) ON DELETE RESTRICT,
        FOREIGN KEY (layout_preset_id) REFERENCES layout_presets(id) ON DELETE RESTRICT
      );
    `)
  })

  // v2: 证书扩展字段
  applyMigration(db, 2, (db) => {
    ensureColumn(db, 'certificates', 'template_id', 'INTEGER REFERENCES svg_templates(id) ON DELETE SET NULL')
    ensureColumn(db, 'certificates', 'column_order', 'TEXT')
    ensureColumn(db, 'certificates', 'table_template_id', 'INTEGER REFERENCES table_templates(id) ON DELETE SET NULL')
    ensureColumn(db, 'certificates', 'block_template_id', 'INTEGER REFERENCES block_templates(id) ON DELETE SET NULL')
    ensureColumn(db, 'certificates', 'group_name', 'TEXT')
    ensureColumn(db, 'certificates', 'preview_ui', "TEXT NOT NULL DEFAULT '{}'")
  })

  // v3: 布局预设扩展字段
  applyMigration(db, 3, (db) => {
    ensureColumn(db, 'layout_presets', 'preview_sample_row', "TEXT NOT NULL DEFAULT '{}'")
    ensureColumn(db, 'layout_presets', 'svg_template_id', 'INTEGER REFERENCES svg_templates(id) ON DELETE SET NULL')
    ensureColumn(db, 'layout_presets', 'table_template_id', 'INTEGER REFERENCES table_templates(id) ON DELETE SET NULL')
    ensureColumn(db, 'layout_presets', 'show_reference_layer', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'layout_presets', 'show_template_layer', 'INTEGER NOT NULL DEFAULT 1')
    ensureColumn(db, 'layout_presets', 'page_width_mm', 'REAL NOT NULL DEFAULT 297')
    ensureColumn(db, 'layout_presets', 'page_height_mm', 'REAL NOT NULL DEFAULT 210')
  })

  // v4: 表格模板样例行 + SVG 模板文件路径
  applyMigration(db, 4, (db) => {
    ensureColumn(db, 'table_templates', 'sample_rows', "TEXT NOT NULL DEFAULT '[]'")
    ensureColumn(db, 'svg_templates', 'file_path', 'TEXT')
  })

  // v5: 布局预设排序 + 页码栏
  applyMigration(db, 5, (db) => {
    ensureColumn(db, 'layout_presets', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'layout_presets', 'page_nav_column', 'TEXT NOT NULL DEFAULT \'\'')
  })

  // v6: 证书行级布局模板 + 回收站
  applyMigration(db, 6, (db) => {
    ensureColumn(db, 'certificate_rows', 'preset_id', 'INTEGER REFERENCES layout_presets(id) ON DELETE SET NULL')
    ensureColumn(db, 'certificates', 'deleted_at', 'TEXT')
    ensureColumn(db, 'certificates', 'trashed_from_status', 'TEXT')
    ensureColumn(db, 'certificates', 'public_slug', 'TEXT')
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cert_public_slug_group
      ON certificates(group_id, public_slug)
      WHERE public_slug IS NOT NULL AND deleted_at IS NULL
    `)
  })

  // v7: 站点品牌按组分
  applyMigration(db, 7, (db) => {
    ensureColumn(db, 'site_branding_by_group', 'public_base_url', 'TEXT')
    ensureColumn(db, 'site_branding_by_group', 'public_cert_param', "TEXT NOT NULL DEFAULT 'cert'")
    ensureColumn(db, 'site_branding_by_group', 'public_cert_url_style', "TEXT NOT NULL DEFAULT 'query'")
  })

  // v8: 访客行为追踪
  applyMigration(db, 8, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS visitor_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visitor_id INTEGER,
        visitor_name TEXT NOT NULL DEFAULT '',
        activity_type TEXT NOT NULL,
        cert_id INTEGER,
        cert_title TEXT NOT NULL DEFAULT '',
        ip_address TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        referrer TEXT NOT NULL DEFAULT '',
        duration_seconds REAL NOT NULL DEFAULT 0,
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_visitor ON visitor_activity_log(visitor_id);
      CREATE INDEX IF NOT EXISTS idx_activity_type ON visitor_activity_log(activity_type);
      CREATE INDEX IF NOT EXISTS idx_activity_time ON visitor_activity_log(created_at);
    `)
  })

  // 向后兼容：如果数据库已有这些表但没有 migrations 记录，
  // 检测并把所有版本标记为已应用（避免对已有数据库重复执行）
  backfillMigrationVersions(db)
}

/**
 * 向后兼容：检测已有数据库结构，补填迁移版本号。
 * 如果 admin_user 等核心表已存在但 migrations 表为空，
 * 则将所有版本标记为已应用。
 */
function backfillMigrationVersions(db) {
  const applied = getAppliedVersions(db)
  if (applied.size > 0) return // 已有迁移记录

  // 检查核心表是否存在（表示数据库并非全新创建）
  const hasTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='admin_user'"
  ).get()
  if (!hasTables) return // 全新数据库，正常走迁移流程

  // 数据库已存在，标记所有版本为已应用
  const now = new Date().toISOString()
  const stmt = db.prepare('INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (?, ?)')
  for (let v = 1; v <= 8; v++) {
    stmt.run(v, now)
  }
  console.log('[DB] 检测到已有数据库，已回填迁移版本 v1-v8')
}

/** 首次添加 sort_order 时，按旧列表规则（默认优先、更新时间）写入顺序 */
export function initLayoutPresetSortOrder(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM layout_presets').get().n
  if (total === 0) return

  const distinct = db.prepare('SELECT COUNT(DISTINCT sort_order) AS n FROM layout_presets').get().n
  if (distinct > 1) return

  const rows = db.prepare(`
    SELECT id FROM layout_presets
    ORDER BY is_default DESC, updated_at DESC, id ASC
  `).all()
  const update = db.prepare('UPDATE layout_presets SET sort_order = ? WHERE id = ?')
  db.transaction(() => {
    rows.forEach((row, i) => update.run(i, row.id))
  })()
}

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export function getDefaultTemplateId(db) {
  const row = db.prepare('SELECT id FROM svg_templates WHERE is_default = 1 LIMIT 1').get()
  return row?.id ?? null
}

export function slugify(name) {
  const base = String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '')
    .slice(0, 60) || 'preset'
  return base
}

export function uniqueSlug(db, table, base, excludeId = null) {
  let slug = slugify(base)
  let n = 0
  while (true) {
    const candidate = n === 0 ? slug : `${slug}-${n}`
    const row = db.prepare(
      `SELECT id FROM ${table} WHERE slug = ?${excludeId != null ? ' AND id != ?' : ''}`,
    ).get(excludeId != null ? [candidate, excludeId] : [candidate])
    if (!row) return candidate
    n += 1
  }
}
