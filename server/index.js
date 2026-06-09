import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { startAutoBackupScheduler, restartAutoBackupScheduler } from './autoBackup.js'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { openDatabase, slugify, uniqueSlug, getDefaultTemplateId, initLayoutPresetSortOrder } from './db.js'
import {
  seedAdminUser,
  createAuthMiddleware,
  createRequireSuperAdmin,
  createRequireModule,
  createVisitorAuthMiddleware,
  formatUserForClient,
  verifyPassword,
  signSession,
  sessionCookie,
  clearSessionCookie,
  getTokenFromRequest,
  verifySession,
  resolvePublicSession,
} from './auth.js'
import {
  sqlGroupInClause,
  sqlPublicGroupInClause,
  resolveGroupIdForCreate,
  resolveGroupIdForUpdate,
  assertRelatedResourcesInGroups,
  assertGroupAccess,
  getDefaultGroupId,
  getUngroupedGroupId,
  loadAdminPrincipal,
} from './accessControl.js'
import { getRowInGroups, getDefaultSvgTemplateIdForPrincipal } from './resourceGuards.js'
import { registerAdminManageRoutes } from './adminManageRoutes.js'
import { isInstalled } from './installState.js'
import { registerInstallRoutes } from './installRoutes.js'
import {
  getFontConfig,
  saveFontConfig,
  getActiveFontSource,
  getPublicFontCatalog,
  seedFontSettings,
  registerFontAssetRoutes,
  getPublicFontDir,
} from './fontSettings.js'
import {
  getSiteConfig,
  getSiteConfigForGroup,
  getSiteConfigForGroups,
  anonymousPublicSiteConfig,
  saveSiteConfigForGroup,
  defaultUntitledTitle,
  defaultCopyTitle,
} from './siteSettings.js'
import { isPseudoStaticCertPathname } from '../src/publicCertUrl.js'
import {
  isPublicCertSlugAvailable,
  resolvePublicSlugForWrite,
  resolvePublishedCertificateByRef,
  suggestPublicCertSlug,
  normalizePublicCertSlug,
} from './certificatePublicSlug.js'
import { registerMediaRoutes, getUploadsRoot } from './mediaRoutes.js'
import {
  buildCertificatePublicSnapshot,
  resolveCertificatePublicSnapshot,
  resolveCertificateTemplateId,
} from './certificateAdornments.js'
import {
  normalizeCertificateRowInput,
  validateCertificateRowPresets,
  validateCertificateForeignResources,
  buildCertificatePresetBundles,
} from './certificateRowPresets.js'
import {
  syncPublishedCertificateAccessGroup,
  syncCertificateAccessGroup,
  validateCertificatePresetGroups,
  resolveCertificateAccessGroupId,
  resolveGroupIdForCertificateCreate,
} from './certificateAccessGroup.js'
import {
  trashCertificate,
  restoreCertificate,
  purgeCertificate,
  assertCertificateNotTrashed,
} from './certificateTrash.js'
import { normalizePageSizeMm } from '../src/pageSize.js'
import {
  normalizePageNavColumnStorage,
  pageNavColumnsEqual,
} from '../src/pageNavColumn.js'
import {
  collectSvgTemplateReferences,
  deleteSvgTemplateWithCleanup,
  formatSvgTemplateDeleteError,
  foreignKeyViolationsForSvgTemplate,
} from './svgTemplateRefs.js'
import {
  deleteSvgTemplateFile,
  formatSvgTemplateRow,
  migrateSvgTemplatesToFiles,
  readSvgTemplateFile,
  resolveSvgTemplateDiskPath,
  syncSvgTemplateFile,
  writeSvgTemplateFile,
} from './svgTemplateFiles.js'
import { registerDataTransferRoutes } from './dataTransfer.js'
import { registerMaintenanceRoutes } from './maintenanceRoutes.js'
import { registerDashboardRoutes } from './dashboardRoutes.js'
import { registerAccountRoutes, registerPublicAccountRoutes } from './accountRoutes.js'
import { attachSearchTextToCertificates, attachTableSearchTextToCertificates } from './certificateSearch.js'
import {
  getAdminLoginSlug,
  getAdminLoginHref,
  saveAdminLoginSlug,
  isAdminLoginPathname,
  isBlockedDefaultAdminLoginPathname,
} from './adminLoginPath.js'
import {
  getPublicLoginSlug,
  getPublicLoginHref,
  savePublicLoginSlug,
  isPublicLoginPathname,
  isBlockedDefaultPublicLoginPathname,
} from './publicLoginPath.js'
import { validateAdminLoginSlug } from '../src/adminLoginPath.js'
import { validatePublicLoginSlug } from '../src/publicLoginPath.js'
import { ADMIN_MODULES } from './adminModules.js'
import { checkLoginRateLimit, clearLoginRateLimit, getClientIp } from './rateLimit.js'
import { syncLayoutPresetsForTableColumnChanges } from './tableTemplateColumnSync.js'
import { registerCertificateRoutes } from './routes/certificates.js'
import { registerPublicRoutes } from './routes/public.js'
import { registerTrackingRoutes } from './visitorTracking.js'

const PORT = Number(process.env.PORT || 3003)
const JWT_SECRET = process.env.JWT_SECRET || 'dev-change-me-in-production'
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'
const CORS_ORIGINS = new Set([
  CORS_ORIGIN,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
])

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')

const dbRef = { current: openDatabase() }
const db = new Proxy({}, {
  get(_, prop) {
    const inst = dbRef.current
    const val = inst[prop]
    return typeof val === 'function' ? val.bind(inst) : val
  },
})

function reconnectDatabase() {
  try {
    dbRef.current.close()
  } catch {
    // ignore
  }
  dbRef.current = openDatabase()
  initLayoutPresetSortOrder(dbRef.current)
  restartAutoBackupScheduler(db, projectRoot)
  return dbRef.current
}
initLayoutPresetSortOrder(db)
const tableTplCols = db.prepare('PRAGMA table_info(table_templates)').all()
if (!tableTplCols.some((c) => c.name === 'sample_rows')) {
  console.error('[CAT API] 缺少 table_templates.sample_rows 列，示例行无法保存。请确认 server/db.js 已更新并重启 API')
} else {
  console.log('[CAT API] table_templates.sample_rows 已就绪')
}
const layoutPresetCols = db.prepare('PRAGMA table_info(layout_presets)').all()
const hasLayoutPresetTplRefs = layoutPresetCols.some((c) => c.name === 'svg_template_id')
  && layoutPresetCols.some((c) => c.name === 'table_template_id')
if (!hasLayoutPresetTplRefs) {
  console.error('[CAT API] 缺少 layout_presets.svg_template_id / table_template_id，布局预设无法记住模板选择。请确认 server/db.js 已更新并重启 API')
} else {
  console.log('[CAT API] layout_presets 模板关联列已就绪')
}
if (!layoutPresetCols.some((c) => c.name === 'page_nav_column')) {
  console.error('[CAT API] 缺少 layout_presets.page_nav_column，页码栏显示列无法保存。请确认 server/db.js 已更新并重启 API')
} else {
  console.log('[CAT API] layout_presets.page_nav_column 已就绪')
}
const certRowCols = db.prepare('PRAGMA table_info(certificate_rows)').all()
if (!certRowCols.some((c) => c.name === 'preset_id')) {
  console.error('[CAT API] 缺少 certificate_rows.preset_id，行级布局模板无法保存。请确认 server/db.js 已更新并重启 API')
} else {
  console.log('[CAT API] certificate_rows.preset_id 已就绪')
}
seedAdminUser(db, ADMIN_USERNAME, ADMIN_PASSWORD)
migrateSvgTemplatesToFiles(db, projectRoot)
seedSvgTemplates(db)
seedFontSettings(db)
const templateCount = db.prepare('SELECT COUNT(*) AS n FROM svg_templates').get().n

function seedSvgTemplates(database) {
  const count = database.prepare('SELECT COUNT(*) AS n FROM svg_templates').get().n
  if (count > 0) return
  const svgPath = path.join(projectRoot, 'SVG1.svg')
  if (!fs.existsSync(svgPath)) {
    console.warn('[CAT API] 未找到 SVG1.svg，跳过默认模板种子')
    return
  }
  const svgContent = fs.readFileSync(svgPath, 'utf8')
  const slug = 'default'
  const filePath = writeSvgTemplateFile(projectRoot, slug, svgContent)
  const ts = nowIso()
  const defaultGroupId = db.prepare('SELECT id FROM access_groups ORDER BY id LIMIT 1').get()?.id ?? null
  database.prepare(`
    INSERT INTO svg_templates (name, slug, svg_content, file_path, is_default, group_id, created_at, updated_at)
    VALUES (?, ?, '', ?, 1, ?, ?, ?)
  `).run('默认证书模板', slug, filePath, defaultGroupId, ts, ts)
  console.log('[CAT API] 已导入默认 SVG 模板到 data/svg-templates/')
}

function resolveTemplateSvg(templateId) {
  if (templateId) {
    const row = db.prepare('SELECT file_path, svg_content FROM svg_templates WHERE id = ?').get(templateId)
    if (row?.file_path) {
      const fromFile = readSvgTemplateFile(projectRoot, row.file_path)
      if (fromFile) return fromFile
    }
    if (row?.svg_content) return row.svg_content
  }
  const defId = getDefaultTemplateId(db)
  if (defId) {
    const row = db.prepare('SELECT file_path, svg_content FROM svg_templates WHERE id = ?').get(defId)
    if (row?.file_path) {
      const fromFile = readSvgTemplateFile(projectRoot, row.file_path)
      if (fromFile) return fromFile
    }
    if (row?.svg_content) return row.svg_content
  }
  return null
}

const requireAuth = createAuthMiddleware(db, JWT_SECRET)
const requireSuperAdmin = createRequireSuperAdmin()
const requireModuleSite = createRequireModule('site')
const requireModuleFonts = createRequireModule('fonts')
const requireModuleTemplates = createRequireModule('templates')
const requireModuleTableTemplates = createRequireModule('table-templates')
const requireModuleLayoutPresets = createRequireModule('layout-presets')
const requireModuleMaintenance = createRequireModule('maintenance')
const requireModuleAccess = createRequireModule('access')
const requireVisitorAuth = createVisitorAuthMiddleware(db, JWT_SECRET)

const app = new Hono()

app.onError((err, c) => {
  console.error('[CAT API] 未捕获错误:', c.req.method, c.req.path, err)
  return c.json({ error: err.message || '服务器内部错误' }, 500)
})

app.use('*', cors({
  origin: (origin) => (origin && CORS_ORIGINS.has(origin) ? origin : CORS_ORIGIN),
  credentials: true,
}))

registerInstallRoutes(app, { db })

registerMediaRoutes(app, { projectRoot, requireAuth, requireVisitorAuth })

app.use('*', async (c, next) => {
  if (isInstalled()) return next()
  const reqPath = c.req.path
  if (reqPath.startsWith('/api/install') || reqPath === '/api/health') return next()
  if (reqPath === '/install.html' || reqPath === '/install') return next()
  if (reqPath.startsWith('/api/')) {
    return c.json({ error: '未完成安装，请先访问 /install.html 完成安装' }, 403)
  }
  return c.redirect('/install.html')
})

function nowIso() {
  return new Date().toISOString()
}

function parseJson(text, fallback = null) {
  if (text == null || text === '') return fallback
  try {
    const parsed = JSON.parse(text)
    return parsed == null ? fallback : parsed
  } catch {
    return fallback
  }
}

function formatPresetRow(row) {
  if (!row) return null
  const pageSize = normalizePageSizeMm(row.page_width_mm, row.page_height_mm)
  return {
    ...row,
    layout_overrides: parseJson(row.layout_overrides, {}),
    preview_sample_row: parseJson(row.preview_sample_row, {}),
    show_layout_boxes: !!row.show_layout_boxes,
    show_reference_layer: row.show_reference_layer != null ? !!row.show_reference_layer : false,
    show_template_layer: row.show_template_layer != null ? !!row.show_template_layer : true,
    is_default: !!row.is_default,
    svg_template_id: row.svg_template_id != null ? Number(row.svg_template_id) : null,
    table_template_id: row.table_template_id != null ? Number(row.table_template_id) : null,
    page_width_mm: pageSize.pageWidthMm,
    page_height_mm: pageSize.pageHeightMm,
    page_nav_column: normalizePageNavColumnStorage(row.page_nav_column),
    group_id: row.group_id != null ? Number(row.group_id) : null,
  }
}

const PRESET_REVISION_LIMIT = 50

function parsePresetRevisionSnapshot(raw) {
  const data = parseJson(raw, {})
  if (data && data.v === 2) return data
  if (data && typeof data === 'object') {
    return {
      v: 1,
      note: '保存',
      layout_overrides: data,
      preview_sample_row: {},
      font_scale: 1,
      show_layout_boxes: false,
      show_reference_layer: false,
      show_template_layer: true,
      svg_template_id: null,
      table_template_id: null,
      page_width_mm: 297,
      page_height_mm: 210,
    }
  }
  return null
}

function buildPresetRevisionSnapshot(merged, note = '保存') {
  const pageSize = normalizePageSizeMm(merged.page_width_mm, merged.page_height_mm)
  return {
    v: 2,
    note,
    layout_overrides: merged.layout_overrides ?? {},
    preview_sample_row: merged.preview_sample_row ?? {},
    font_scale: merged.font_scale ?? 1,
    show_layout_boxes: !!merged.show_layout_boxes,
    show_reference_layer: merged.show_reference_layer != null ? !!merged.show_reference_layer : false,
    show_template_layer: merged.show_template_layer !== false,
    svg_template_id: merged.svg_template_id ?? null,
    table_template_id: merged.table_template_id ?? null,
    page_width_mm: pageSize.pageWidthMm,
    page_height_mm: pageSize.pageHeightMm,
    page_nav_column: normalizePageNavColumnStorage(merged.page_nav_column),
  }
}

function trimPresetRevisions(presetId) {
  const rows = db.prepare(
    'SELECT id FROM layout_preset_revisions WHERE preset_id = ? ORDER BY id DESC',
  ).all(presetId)
  for (let i = PRESET_REVISION_LIMIT; i < rows.length; i += 1) {
    db.prepare('DELETE FROM layout_preset_revisions WHERE id = ?').run(rows[i].id)
  }
}

function insertPresetRevision(presetId, snapshotObj, createdAt) {
  db.prepare(`
    INSERT INTO layout_preset_revisions (preset_id, snapshot, created_at)
    VALUES (?, ?, ?)
  `).run(presetId, JSON.stringify(snapshotObj), createdAt)
  trimPresetRevisions(presetId)
}

function mergePresetFields(prev, body) {
  const layoutOverrides = body.layout_overrides != null
    ? body.layout_overrides
    : parseJson(prev.layout_overrides, {})
  const previewSampleRow = body.preview_sample_row != null
    ? body.preview_sample_row
    : parseJson(prev.preview_sample_row, {})
  return {
    name: body.name != null ? String(body.name).trim() : prev.name,
    layout_overrides: layoutOverrides,
    preview_sample_row: previewSampleRow,
    font_scale: body.font_scale != null ? Number(body.font_scale) : prev.font_scale,
    show_layout_boxes: body.show_layout_boxes != null ? !!body.show_layout_boxes : !!prev.show_layout_boxes,
    show_reference_layer: body.show_reference_layer != null
      ? !!body.show_reference_layer
      : (prev.show_reference_layer != null ? !!prev.show_reference_layer : false),
    show_template_layer: body.show_template_layer != null
      ? !!body.show_template_layer
      : (prev.show_template_layer != null ? !!prev.show_template_layer : true),
    svg_template_id: body.svg_template_id != null
      ? (Number(body.svg_template_id) || null)
      : (prev.svg_template_id != null ? Number(prev.svg_template_id) : null),
    table_template_id: body.table_template_id != null
      ? (Number(body.table_template_id) || null)
      : (prev.table_template_id != null ? Number(prev.table_template_id) : null),
    page_width_mm: body.page_width_mm != null
      ? normalizePageSizeMm(body.page_width_mm, body.page_height_mm ?? prev.page_height_mm).pageWidthMm
      : (prev.page_width_mm != null ? Number(prev.page_width_mm) : 297),
    page_height_mm: body.page_height_mm != null
      ? normalizePageSizeMm(body.page_width_mm ?? prev.page_width_mm, body.page_height_mm).pageHeightMm
      : (prev.page_height_mm != null ? Number(prev.page_height_mm) : 210),
    page_nav_column: body.page_nav_column != null
      ? normalizePageNavColumnStorage(body.page_nav_column)
      : normalizePageNavColumnStorage(prev.page_nav_column),
    group_id: body.group_id !== undefined
      ? (body.group_id != null ? Number(body.group_id) : null)
      : (prev.group_id != null ? Number(prev.group_id) : null),
  }
}

function clearGroupDefault(db, table, groupId, exceptId = null) {
  if (groupId == null) return
  if (exceptId != null) {
    db.prepare(`UPDATE ${table} SET is_default = 0 WHERE group_id = ? AND id != ?`).run(groupId, exceptId)
  } else {
    db.prepare(`UPDATE ${table} SET is_default = 0 WHERE group_id = ?`).run(groupId)
  }
}

function applyPresetFieldsToDb(id, merged, ts, { updateGroupId = false } = {}) {
  const pageSize = normalizePageSizeMm(merged.page_width_mm, merged.page_height_mm)
  if (updateGroupId) {
    const groupId = merged.group_id != null ? Number(merged.group_id) : null
    db.prepare(`
      UPDATE layout_presets SET name = ?, layout_overrides = ?, preview_sample_row = ?, font_scale = ?, show_layout_boxes = ?, show_reference_layer = ?, show_template_layer = ?, svg_template_id = ?, table_template_id = ?, page_width_mm = ?, page_height_mm = ?, page_nav_column = ?, group_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.name,
      JSON.stringify(merged.layout_overrides || {}),
      JSON.stringify(merged.preview_sample_row || {}),
      Number(merged.font_scale) || 1,
      merged.show_layout_boxes ? 1 : 0,
      merged.show_reference_layer ? 1 : 0,
      merged.show_template_layer ? 1 : 0,
      merged.svg_template_id,
      merged.table_template_id,
      pageSize.pageWidthMm,
      pageSize.pageHeightMm,
      String(merged.page_nav_column || '').trim(),
      groupId,
      ts,
      id,
    )
    return
  }
  db.prepare(`
    UPDATE layout_presets SET name = ?, layout_overrides = ?, preview_sample_row = ?, font_scale = ?, show_layout_boxes = ?, show_reference_layer = ?, show_template_layer = ?, svg_template_id = ?, table_template_id = ?, page_width_mm = ?, page_height_mm = ?, page_nav_column = ?, updated_at = ?
    WHERE id = ?
  `).run(
    merged.name,
    JSON.stringify(merged.layout_overrides || {}),
    JSON.stringify(merged.preview_sample_row || {}),
    Number(merged.font_scale) || 1,
    merged.show_layout_boxes ? 1 : 0,
    merged.show_reference_layer ? 1 : 0,
    merged.show_template_layer ? 1 : 0,
    merged.svg_template_id,
    merged.table_template_id,
    pageSize.pageWidthMm,
    pageSize.pageHeightMm,
    String(merged.page_nav_column || '').trim(),
    ts,
    id,
  )
}

// —— Auth ——
app.post('/api/auth/login', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const username = String(body.username || '').trim()
    const password = String(body.password || '')
    if (!username || !password) {
      return c.json({ error: '请输入用户名和密码' }, 400)
    }

    const ip = getClientIp(c)
    const limit = checkLoginRateLimit(username, ip)
    if (!limit.allowed) {
      return c.json({ error: `登录尝试次数过多，请 ${limit.retryAfterSec} 秒后重试` }, 429)
    }

    const user = db.prepare('SELECT id, username, role, password_hash FROM admin_user WHERE username = ?').get(username)
    if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
      return c.json({ error: '用户名或密码错误' }, 401)
    }

    clearLoginRateLimit(username, ip)

    const principal = loadAdminPrincipal(db, user)
    const token = await signSession(
      { sub: String(user.id), username: user.username, typ: 'admin' },
      JWT_SECRET,
    )
    c.header('Set-Cookie', sessionCookie(token))
    return c.json({ ok: true, user: formatUserForClient(principal) })
  } catch (err) {
    console.error('[CAT API] 登录失败:', err)
    return c.json({ error: err.message || '登录处理失败' }, 500)
  }
})

app.post('/api/auth/logout', (c) => {
  c.header('Set-Cookie', clearSessionCookie())
  return c.json({ ok: true })
})

app.get('/api/auth/me', async (c) => {
  const token = getTokenFromRequest(c.req.raw)
  if (!token) return c.json({ user: null })
  try {
    const payload = await verifySession(token, JWT_SECRET)
    if (payload.typ === 'visitor') return c.json({ user: null })
    const user = db.prepare('SELECT id, username, role, avatar_path FROM admin_user WHERE id = ?').get(payload.sub)
    if (!user) return c.json({ user: null })
    const principal = loadAdminPrincipal(db, user)
    return c.json({ user: formatUserForClient(principal) })
  } catch {
    return c.json({ user: null })
  }
})

app.get('/api/admin-modules', requireAuth, (c) => {
  return c.json({ modules: ADMIN_MODULES })
})

// —— Layout presets (admin) ——
app.get('/api/presets', requireAuth, (c) => {
  const principal = c.get('principal')
  const gf = sqlGroupInClause(principal)
  const rows = db.prepare(`
    SELECT id, name, slug, group_id, font_scale, show_layout_boxes, is_default,
      svg_template_id, table_template_id, created_at, updated_at
    FROM layout_presets WHERE 1=1${gf.clause}
    ORDER BY sort_order ASC, id ASC
  `).all(...gf.params)
  const seen = new Set()
  const presets = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    presets.push({
      ...row,
      show_layout_boxes: !!row.show_layout_boxes,
      is_default: !!row.is_default,
      group_id: row.group_id != null ? Number(row.group_id) : null,
      svg_template_id: row.svg_template_id != null ? Number(row.svg_template_id) : null,
      table_template_id: row.table_template_id != null ? Number(row.table_template_id) : null,
    })
  }
  return c.json({ presets })
})

app.put('/api/presets/reorder', requireAuth, requireModuleLayoutPresets, async (c) => {
  const principal = c.get('principal')
  const gf = sqlGroupInClause(principal)
  const body = await c.req.json()
  const ids = Array.isArray(body.ids)
    ? body.ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
    : []
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length !== ids.length) {
    return c.json({ error: '顺序列表含重复 id' }, 400)
  }
  const all = db.prepare(`
    SELECT id FROM layout_presets WHERE 1=1${gf.clause}
    ORDER BY sort_order ASC, id ASC
  `).all(...gf.params)
  const allIds = [...new Set(all.map((r) => r.id))]
  if (uniqueIds.length !== allIds.length) {
    return c.json({ error: '顺序列表不完整' }, 400)
  }
  const set = new Set(uniqueIds)
  if (allIds.some((id) => !set.has(id))) {
    return c.json({ error: '含无效 id' }, 400)
  }
  const updateOrder = db.prepare('UPDATE layout_presets SET sort_order = ? WHERE id = ?')
  db.transaction(() => {
    uniqueIds.forEach((id, i) => updateOrder.run(i, id))
  })()
  return c.json({ ok: true })
})

async function handlePresetGroupUpdate(c) {
  const principal = c.get('principal')
  const id = Number(c.req.param('id'))
  const prev = getRowInGroups(db, 'layout_presets', id, principal)
  if (!prev) return c.json({ error: '未找到' }, 404)

  const body = await c.req.json().catch(() => ({}))
  if (body.group_id === undefined) {
    return c.json({ error: '缺少 group_id' }, 400)
  }

  let groupId
  try {
    groupId = resolveGroupIdForUpdate(db, principal, body.group_id, prev.group_id)
  } catch (err) {
    return c.json({ error: err.message }, 403)
  }

  const ts = nowIso()
  db.prepare('UPDATE layout_presets SET group_id = ?, updated_at = ? WHERE id = ?').run(groupId, ts, id)
  const updated = db.prepare('SELECT * FROM layout_presets WHERE id = ?').get(id)
  return c.json({
    ok: true,
    preset: formatPresetRow(updated),
    group_id: updated?.group_id != null ? Number(updated.group_id) : null,
  })
}

app.patch('/api/presets/:id/group', requireAuth, handlePresetGroupUpdate)
app.put('/api/presets/:id/group', requireAuth, requireModuleLayoutPresets, handlePresetGroupUpdate)
app.post('/api/presets/:id/group', requireAuth, requireModuleLayoutPresets, handlePresetGroupUpdate)

app.get('/api/presets/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const row = getRowInGroups(db, 'layout_presets', id, c.get('principal'))
  if (!row) return c.json({ error: '未找到' }, 404)
  return c.json({ preset: formatPresetRow(row) })
})

app.post('/api/presets', requireAuth, requireModuleLayoutPresets, async (c) => {
  const principal = c.get('principal')
  const body = await c.req.json()
  const name = String(body.name || '未命名预设').trim()
  const slug = uniqueSlug(db, 'layout_presets', body.slug || name)

  let groupId
  try {
    groupId = resolveGroupIdForCreate(db, principal, body.group_id)
  } catch (err) {
    return c.json({ error: err.message }, 400)
  }

  const svgTemplateId = body.svg_template_id != null ? Number(body.svg_template_id) || null : null
  const tableTemplateId = body.table_template_id != null ? Number(body.table_template_id) || null : null
  try {
    assertRelatedResourcesInGroups(db, principal, { svgTemplateId, tableTemplateId })
  } catch (err) {
    return c.json({ error: err.message }, 403)
  }

  const ts = nowIso()
  const layoutOverrides = JSON.stringify(body.layout_overrides || {})
  const previewSampleRow = JSON.stringify(body.preview_sample_row || {})
  const pageSize = normalizePageSizeMm(body.page_width_mm, body.page_height_mm)
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM layout_presets').get().m
  const sortOrder = maxSort + 1
  const result = db.prepare(`
    INSERT INTO layout_presets (name, slug, group_id, layout_overrides, preview_sample_row, font_scale, show_layout_boxes, show_reference_layer, show_template_layer, is_default, svg_template_id, table_template_id, page_width_mm, page_height_mm, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    slug,
    groupId,
    layoutOverrides,
    previewSampleRow,
    Number(body.font_scale) || 1,
    body.show_layout_boxes ? 1 : 0,
    body.show_reference_layer ? 1 : 0,
    body.show_template_layer !== false ? 1 : 0,
    body.is_default ? 1 : 0,
    svgTemplateId,
    tableTemplateId,
    pageSize.pageWidthMm,
    pageSize.pageHeightMm,
    sortOrder,
    ts,
    ts,
  )

  if (body.is_default) {
    clearGroupDefault(db, 'layout_presets', groupId, result.lastInsertRowid)
  }

  const createdPreset = db.prepare('SELECT * FROM layout_presets WHERE id = ?').get(result.lastInsertRowid)
  insertPresetRevision(
    result.lastInsertRowid,
    buildPresetRevisionSnapshot(formatPresetRow(createdPreset), '创建'),
    ts,
  )

  return c.json({ id: result.lastInsertRowid, slug })
})

app.put('/api/presets/:id', requireAuth, requireModuleLayoutPresets, async (c) => {
  const principal = c.get('principal')
  const id = Number(c.req.param('id'))
  const prev = getRowInGroups(db, 'layout_presets', id, principal)
  if (!prev) return c.json({ error: '未找到' }, 404)

  const body = await c.req.json()
  try {
    assertRelatedResourcesInGroups(db, principal, {
      svgTemplateId: body.svg_template_id != null ? Number(body.svg_template_id) || null : prev.svg_template_id,
      tableTemplateId: body.table_template_id != null ? Number(body.table_template_id) || null : prev.table_template_id,
    })
  } catch (err) {
    return c.json({ error: err.message }, 403)
  }

  let groupId = prev.group_id != null ? Number(prev.group_id) : null
  if (body.group_id !== undefined) {
    try {
      groupId = resolveGroupIdForUpdate(db, principal, body.group_id, prev.group_id)
    } catch (err) {
      return c.json({ error: err.message }, 403)
    }
  }

  const merged = mergePresetFields(prev, body)
  merged.group_id = groupId
  const ts = nowIso()

  applyPresetFieldsToDb(id, merged, ts, { updateGroupId: body.group_id !== undefined })

  if (body.is_default) {
    clearGroupDefault(db, 'layout_presets', groupId, id)
    db.prepare('UPDATE layout_presets SET is_default = 1 WHERE id = ?').run(id)
  }

  if (body.record_revision === true) {
    insertPresetRevision(
      id,
      buildPresetRevisionSnapshot(merged, String(body.revision_note || '保存').trim() || '保存'),
      ts,
    )
  }

  const updated = db.prepare('SELECT * FROM layout_presets WHERE id = ?').get(id)
  return c.json({ ok: true, preset: formatPresetRow(updated) })
})

app.delete('/api/presets/:id', requireAuth, requireModuleLayoutPresets, (c) => {
  const id = Number(c.req.param('id'))
  if (!getRowInGroups(db, 'layout_presets', id, c.get('principal'))) {
    return c.json({ error: '未找到' }, 404)
  }
  db.prepare('DELETE FROM layout_presets WHERE id = ?').run(id)
  return c.json({ ok: true })
})

app.get('/api/presets/:id/revisions', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!getRowInGroups(db, 'layout_presets', id, c.get('principal'))) {
    return c.json({ error: '未找到' }, 404)
  }
  const rows = db.prepare(`
    SELECT id, created_at, snapshot FROM layout_preset_revisions WHERE preset_id = ? ORDER BY id DESC LIMIT 50
  `).all(id)
  return c.json({
    revisions: rows.map((row) => {
      const snap = parsePresetRevisionSnapshot(row.snapshot)
      return {
        id: row.id,
        created_at: row.created_at,
        note: snap?.note || '保存',
      }
    }),
  })
})

app.post('/api/presets/:id/revisions/:revId/restore', requireAuth, requireModuleLayoutPresets, (c) => {
  const presetId = Number(c.req.param('id'))
  if (!getRowInGroups(db, 'layout_presets', presetId, c.get('principal'))) {
    return c.json({ error: '未找到' }, 404)
  }
  const revId = Number(c.req.param('revId'))
  const row = db.prepare(
    'SELECT snapshot FROM layout_preset_revisions WHERE id = ? AND preset_id = ?',
  ).get(revId, presetId)
  if (!row) return c.json({ error: '未找到' }, 404)

  const snap = parsePresetRevisionSnapshot(row.snapshot)
  if (!snap) return c.json({ error: '修订数据无效' }, 400)

  const prev = db.prepare('SELECT * FROM layout_presets WHERE id = ?').get(presetId)
  if (!prev) return c.json({ error: '未找到' }, 404)

  const merged = mergePresetFields(prev, {
    layout_overrides: snap.layout_overrides,
    preview_sample_row: snap.preview_sample_row,
    font_scale: snap.font_scale,
    show_layout_boxes: snap.show_layout_boxes,
    show_reference_layer: snap.show_reference_layer,
    show_template_layer: snap.show_template_layer,
    svg_template_id: snap.svg_template_id,
    table_template_id: snap.table_template_id,
    page_width_mm: snap.page_width_mm,
    page_height_mm: snap.page_height_mm,
    page_nav_column: snap.page_nav_column,
  })
  const ts = nowIso()
  applyPresetFieldsToDb(presetId, merged, ts)
  insertPresetRevision(
    presetId,
    buildPresetRevisionSnapshot(merged, `恢复修订 #${revId}`),
    ts,
  )

  const updated = db.prepare('SELECT * FROM layout_presets WHERE id = ?').get(presetId)
  return c.json({ ok: true, preset: formatPresetRow(updated) })
})

// —— SVG templates (admin) ——
app.get('/api/templates', requireAuth, (c) => {
  const gf = sqlGroupInClause(c.get('principal'))
  const rows = db.prepare(`
    SELECT id, name, slug, file_path, is_default, group_id, created_at, updated_at, svg_content
    FROM svg_templates WHERE 1=1${gf.clause}
    ORDER BY is_default DESC, updated_at DESC
  `).all(...gf.params)
  return c.json({
    templates: rows.map((r) => ({
      ...formatSvgTemplateRow(r, projectRoot),
      group_id: r.group_id != null ? Number(r.group_id) : null,
    })),
  })
})

app.get('/api/templates/:id/file', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const row = getRowInGroups(db, 'svg_templates', id, c.get('principal'))
  if (!row) return c.json({ error: '未找到' }, 404)
  const content = row.file_path
    ? readSvgTemplateFile(projectRoot, row.file_path)
    : (row.svg_content || null)
  if (!content || !content.includes('<svg')) {
    return c.json({ error: '模板文件不存在' }, 404)
  }
  return c.body(content, 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'no-store',
  })
})

app.get('/api/templates/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const row = getRowInGroups(db, 'svg_templates', id, c.get('principal'))
  if (!row) return c.json({ error: '未找到' }, 404)
  return c.json({
    template: {
      ...formatSvgTemplateRow(row, projectRoot),
      group_id: row.group_id != null ? Number(row.group_id) : null,
    },
  })
})

async function parseSvgTemplateUpload(c) {
  const contentType = c.req.header('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody()
    const file = body.file ?? body.svg
    if (!file || typeof file === 'string') {
      return { error: '请使用 multipart 字段 file 上传 SVG 文件' }
    }
    const buf = Buffer.from(await file.arrayBuffer())
    const svgContent = buf.toString('utf8')
    if (!svgContent.includes('<svg')) return { error: '无效的 SVG 文件' }
    const name = String(body.name || file.name || '未命名模板').replace(/\.svg$/i, '').trim() || '未命名模板'
    const isDefault = body.is_default === '1' || body.is_default === 'true' || body.is_default === true
    const groupIdRaw = body.group_id != null ? Number(body.group_id) : null
    return { name, svgContent, isDefault: !!isDefault, groupId: groupIdRaw > 0 ? groupIdRaw : null }
  }

  const body = await c.req.json().catch(() => ({}))
  const svgContent = String(body.svg_content || '').trim()
  if (!svgContent.includes('<svg')) return { error: '无效的 SVG 内容' }
  const name = String(body.name || '未命名模板').trim() || '未命名模板'
  const groupIdRaw = body.group_id != null ? Number(body.group_id) : null
  return {
    name,
    svgContent,
    isDefault: !!body.is_default,
    groupId: groupIdRaw > 0 ? groupIdRaw : null,
  }
}

app.post('/api/templates', requireAuth, requireModuleTemplates, async (c) => {
  const principal = c.get('principal')
  const parsed = await parseSvgTemplateUpload(c)
  if (parsed.error) return c.json({ error: parsed.error }, 400)

  const { name, svgContent, isDefault, groupId: requestedGroupId } = parsed
  let groupId
  try {
    groupId = resolveGroupIdForCreate(db, principal, requestedGroupId)
  } catch (err) {
    return c.json({ error: err.message }, 400)
  }

  const slug = uniqueSlug(db, 'svg_templates', name)
  const ts = nowIso()
  if (isDefault) {
    clearGroupDefault(db, 'svg_templates', groupId)
  }
  const filePath = writeSvgTemplateFile(projectRoot, slug, svgContent)
  const result = db.prepare(`
    INSERT INTO svg_templates (name, slug, svg_content, file_path, is_default, group_id, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, ?, ?, ?)
  `).run(name, slug, filePath, isDefault ? 1 : 0, groupId, ts, ts)
  return c.json({ id: result.lastInsertRowid, file_url: formatSvgTemplateRow({ file_path: filePath }, projectRoot).file_url })
})

app.put('/api/templates/:id', requireAuth, requireModuleTemplates, async (c) => {
  const principal = c.get('principal')
  const id = Number(c.req.param('id'))
  const prev = getRowInGroups(db, 'svg_templates', id, principal)
  if (!prev) return c.json({ error: '未找到' }, 404)

  const contentType = c.req.header('content-type') || ''
  let body = {}
  let uploadedSvg = null
  if (contentType.includes('multipart/form-data')) {
    const parsed = await c.req.parseBody()
    body.name = parsed.name
    body.is_default = parsed.is_default
    if (parsed.group_id != null) body.group_id = parsed.group_id
    const file = parsed.file ?? parsed.svg
    if (file && typeof file !== 'string') {
      uploadedSvg = Buffer.from(await file.arrayBuffer()).toString('utf8')
    }
  } else {
    body = await c.req.json().catch(() => ({}))
    uploadedSvg = body.svg_content != null ? String(body.svg_content) : null
  }

  const ts = nowIso()
  const name = body.name != null ? String(body.name).trim() : prev.name
  let slug = prev.slug
  if (body.slug != null) slug = uniqueSlug(db, 'svg_templates', body.slug, id)
  if (uploadedSvg != null && !uploadedSvg.includes('<svg')) {
    return c.json({ error: '无效的 SVG 内容' }, 400)
  }
  if (body.is_default) {
    clearGroupDefault(db, 'svg_templates', prev.group_id, id)
  }
  const isDefault = body.is_default != null ? (body.is_default ? 1 : 0) : prev.is_default

  let groupId = prev.group_id
  if (body.group_id !== undefined) {
    try {
      groupId = resolveGroupIdForUpdate(db, principal, body.group_id, prev.group_id)
    } catch (err) {
      return c.json({ error: err.message }, 403)
    }
  }

  let filePath = prev.file_path
  try {
    filePath = syncSvgTemplateFile(projectRoot, prev, {
      slug,
      svgContent: uploadedSvg,
    })
  } catch (err) {
    return c.json({ error: err.message || '保存 SVG 文件失败' }, 400)
  }

  db.prepare(`
    UPDATE svg_templates SET name = ?, slug = ?, svg_content = '', file_path = ?, is_default = ?, group_id = ?, updated_at = ?
    WHERE id = ?
  `).run(name, slug, filePath, isDefault, groupId, ts, id)
  return c.json({ ok: true, file_url: formatSvgTemplateRow({ file_path: filePath }, projectRoot).file_url })
})

app.delete('/api/templates/:id', requireAuth, requireModuleTemplates, (c) => {
  const id = Number(c.req.param('id'))
  const row = getRowInGroups(db, 'svg_templates', id, c.get('principal'))
  if (!row) return c.json({ error: '未找到' }, 404)

  try {
    const result = deleteSvgTemplateWithCleanup(db, id)
    if (!result.ok) {
      return c.json({ error: result.error, references: result.references }, 400)
    }

    deleteSvgTemplateFile(projectRoot, row.file_path)

    if (row.is_default) {
      const next = db.prepare(`
        SELECT id FROM svg_templates WHERE group_id = ? ORDER BY updated_at DESC LIMIT 1
      `).get(row.group_id)
      if (next) db.prepare('UPDATE svg_templates SET is_default = 1 WHERE id = ?').run(next.id)
    }
    return c.json({ ok: true, cleaned: result.cleaned })
  } catch (err) {
    let references = collectSvgTemplateReferences(db, id)
    let error = formatSvgTemplateDeleteError(references)
    if (!error) {
      const violations = foreignKeyViolationsForSvgTemplate(db, id)
      const tables = [...new Set(violations.map((v) => v.table))]
      error = '无法删除此 SVG 模板，数据库外键约束未通过'
      if (tables.length) {
        error += `（仍有 ${tables.join('、')} 表在引用）`
      }
      if (!references.length && tables.length) {
        references = [{
          kind: 'foreign_key',
          label: `数据库外键引用（${tables.join('、')}）`,
          blocksDelete: true,
          autoClean: false,
          count: violations.length,
          items: violations.map((v) => ({ id: v.rowid, name: v.table })),
        }]
      }
    }
    if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || err?.code === 'SQLITE_CONSTRAINT_TRIGGER') {
      return c.json({ error, references }, 400)
    }
    throw err
  }
})

function normalizeTableTemplateColumns(value) {
  if (!Array.isArray(value)) return []
  return value.map((c) => String(c).trim()).filter(Boolean)
}

function normalizeTableTemplateSampleRows(value, columns) {
  if (!Array.isArray(value)) return []
  const cols = normalizeTableTemplateColumns(columns)
  return value.map((row) => {
    if (!row || typeof row !== 'object') return Object.fromEntries(cols.map((c) => [c, '']))
    const out = {}
    for (const col of cols) {
      out[col] = row[col] != null ? String(row[col]) : ''
    }
    return out
  })
}

function normalizeColumnOrder(value) {
  if (!Array.isArray(value)) return null
  const cols = value.map((c) => String(c).trim()).filter(Boolean)
  return cols.length > 0 ? cols : null
}

// —— Table templates (admin) ——
app.get('/api/table-templates', requireAuth, (c) => {
  const gf = sqlGroupInClause(c.get('principal'))
  const rows = db.prepare(`
    SELECT id, name, slug, columns, sample_rows, is_default, group_id, created_at, updated_at
    FROM table_templates WHERE 1=1${gf.clause}
    ORDER BY is_default DESC, updated_at DESC
  `).all(...gf.params)
  return c.json({
    templates: rows.map((r) => {
      const columns = parseJson(r.columns, [])
      const sampleRowsRaw = parseJson(r.sample_rows, [])
      const sampleRows = Array.isArray(sampleRowsRaw) ? sampleRowsRaw : []
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        columns,
        sample_rows: sampleRows,
        column_count: columns.length,
        sample_row_count: sampleRows.length,
        is_default: !!r.is_default,
        group_id: r.group_id != null ? Number(r.group_id) : null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }
    }),
  })
})

app.get('/api/table-templates/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const row = getRowInGroups(db, 'table_templates', id, c.get('principal'))
  if (!row) return c.json({ error: '未找到' }, 404)
  const columns = parseJson(row.columns, [])
  return c.json({
    template: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      columns,
      sample_rows: (() => {
        const raw = parseJson(row.sample_rows, [])
        return Array.isArray(raw) ? raw : []
      })(),
      is_default: !!row.is_default,
      group_id: row.group_id != null ? Number(row.group_id) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  })
})

app.post('/api/table-templates', requireAuth, requireModuleTableTemplates, async (c) => {
  const principal = c.get('principal')
  const body = await c.req.json().catch(() => ({}))
  const name = String(body.name || '未命名表格').trim()
  const columns = normalizeTableTemplateColumns(body.columns ?? [])
  const sampleRows = normalizeTableTemplateSampleRows(body.sample_rows ?? [], columns)
  const slug = uniqueSlug(db, 'table_templates', body.slug || name)
  let groupId
  try {
    groupId = resolveGroupIdForCreate(db, principal, body.group_id)
  } catch (err) {
    return c.json({ error: err.message }, 400)
  }
  const ts = nowIso()
  const isDefault = body.is_default ? 1 : 0
  if (isDefault) {
    clearGroupDefault(db, 'table_templates', groupId)
  }
  const result = db.prepare(`
    INSERT INTO table_templates (name, slug, columns, sample_rows, is_default, group_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, slug, JSON.stringify(columns), JSON.stringify(sampleRows), isDefault, groupId, ts, ts)
  return c.json({ id: result.lastInsertRowid })
})

app.put('/api/table-templates/:id', requireAuth, requireModuleTableTemplates, async (c) => {
  const id = Number(c.req.param('id'))
  const prev = getRowInGroups(db, 'table_templates', id, c.get('principal'))
  if (!prev) return c.json({ error: '未找到' }, 404)
  const body = await c.req.json()
  const ts = nowIso()
  const name = body.name != null ? String(body.name).trim() : prev.name
  let slug = prev.slug
  if (body.slug != null) slug = uniqueSlug(db, 'table_templates', body.slug, id)
  const prevColumns = parseJson(prev.columns, [])
  const columns = body.columns != null
    ? normalizeTableTemplateColumns(body.columns)
    : prevColumns
  const sampleRows = body.sample_rows != null
    ? normalizeTableTemplateSampleRows(body.sample_rows, columns)
    : normalizeTableTemplateSampleRows(parseJson(prev.sample_rows, []), columns)
  if (body.is_default) {
    clearGroupDefault(db, 'table_templates', prev.group_id, id)
  }
  const isDefault = body.is_default != null ? (body.is_default ? 1 : 0) : prev.is_default
  let groupId = prev.group_id
  if (body.group_id !== undefined) {
    try {
      groupId = resolveGroupIdForUpdate(db, c.get('principal'), body.group_id, prev.group_id)
    } catch (err) {
      return c.json({ error: err.message }, 403)
    }
  }
  db.prepare(`
    UPDATE table_templates SET name = ?, slug = ?, columns = ?, sample_rows = ?, is_default = ?, group_id = ?, updated_at = ?
    WHERE id = ?
  `).run(name, slug, JSON.stringify(columns), JSON.stringify(sampleRows), isDefault, groupId, ts, id)

  let layoutPresetsUpdated = 0
  if (body.columns != null) {
    const sync = syncLayoutPresetsForTableColumnChanges(db, id, prevColumns, columns, ts)
    layoutPresetsUpdated = sync.presetsUpdated
  }

  return c.json({
    ok: true,
    template: {
      id,
      name,
      columns,
      sample_rows: sampleRows,
      sample_row_count: sampleRows.length,
      column_count: columns.length,
      group_id: groupId != null ? Number(groupId) : null,
    },
    layout_presets_updated: layoutPresetsUpdated,
  })
})

app.delete('/api/table-templates/:id', requireAuth, requireModuleTableTemplates, (c) => {
  const id = Number(c.req.param('id'))
  const row = getRowInGroups(db, 'table_templates', id, c.get('principal'))
  if (!row) return c.json({ error: '未找到' }, 404)
  db.prepare('DELETE FROM table_templates WHERE id = ?').run(id)
  if (row.is_default) {
    const next = db.prepare(`
      SELECT id FROM table_templates WHERE group_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(row.group_id)
    if (next) db.prepare('UPDATE table_templates SET is_default = 1 WHERE id = ?').run(next.id)
  }
  return c.json({ ok: true })
})

// ============================================================================
// 共享上下文（供拆分后的路由模块使用）
// ============================================================================
function certificateSnapshot(certId) {
  const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(certId)
  if (!cert) return null
  const rows = db.prepare(`
    SELECT sort_order, row_data, preset_id FROM certificate_rows WHERE certificate_id = ? ORDER BY sort_order
  `).all(certId)
  return {
    title: cert.title,
    status: cert.status,
    preset_id: cert.preset_id,
    template_id: cert.template_id ?? null,
    table_template_id: cert.table_template_id ?? null,
    group_name: cert.group_name ?? null,
    column_order: parseJson(cert.column_order, null),
    layout_overrides: parseJson(cert.layout_overrides, {}),
    font_scale: cert.font_scale,
    show_layout_boxes: !!cert.show_layout_boxes,
    preview_ui: parseJson(cert.preview_ui, {}),
    rows: rows.map((r) => ({
      sort_order: r.sort_order,
      row_data: parseJson(r.row_data, {}),
      preset_id: r.preset_id != null ? Number(r.preset_id) : null,
    })),
  }
}

const routeCtx = {
  db,
  JWT_SECRET,
  nowIso,
  parseJson,
  normalizeColumnOrder,
  resolveTemplateSvg,
  requireAuth,
  requireVisitorAuth,
  certificateSnapshot,
}

// 拆分后的路由模块
registerCertificateRoutes(app, routeCtx)
registerPublicRoutes(app, routeCtx)

registerFontAssetRoutes(app, { projectRoot, requireAuth, requireModuleFonts })
registerDataTransferRoutes(app, { db, requireAuth, projectRoot })
registerMaintenanceRoutes(app, {
  db,
  projectRoot,
  requireAuth,
  requireMaintenance: requireModuleMaintenance,
  reconnectDatabase,
})
registerDashboardRoutes(app, { db, projectRoot, requireAuth })
registerAccountRoutes(app, { db, projectRoot, requireAuth })
registerPublicAccountRoutes(app, { db, projectRoot, requireVisitorAuth })
registerAdminManageRoutes(app, { db, secret: JWT_SECRET, requireAuth, requireAccessModule: requireModuleAccess })
registerTrackingRoutes(app, { db, JWT_SECRET, requireAuth })

app.use(
  '/font/*',
  serveStatic({
    root: getPublicFontDir(projectRoot),
    rewriteRequestPath: (p) => {
      const sub = p.replace(/^\/font\/?/, '')
      return sub || '.'
    },
  }),
)

app.use(
  '/uploads/*',
  serveStatic({
    root: getUploadsRoot(projectRoot),
  }),
)

app.get('/svg-templates/*', requireAuth, (c) => {
  const sub = c.req.path.replace(/^\/svg-templates\//, '')
  try {
    const disk = resolveSvgTemplateDiskPath(projectRoot, sub)
    if (!fs.existsSync(disk)) return c.json({ error: '未找到' }, 404)
    const content = fs.readFileSync(disk, 'utf8')
    return c.body(content, 200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    })
  } catch {
    return c.json({ error: '非法路径' }, 403)
  }
})

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/public/font-config', (c) => {
  return c.json(getPublicFontCatalog(db))
})

app.get('/api/public/site-config', async (c) => {
  try {
    const session = await resolvePublicSession(db, c.req.raw, JWT_SECRET)
    const requested = c.req.query('group_id')
    if (requested != null && requested !== '' && session) {
      const groupId = Number(requested)
      if (Number.isFinite(groupId) && groupId > 0) {
        const allowed = session.adminPrincipal?.isSuperAdmin
          || (session.principal?.groupIds || []).includes(groupId)
        if (!allowed) return c.json({ error: '无权访问该组的站点设置' }, 403)
        return c.json(getSiteConfigForGroup(db, groupId))
      }
    }
    if (!session) return c.json(anonymousPublicSiteConfig())
    const groupIds = session.principal?.groupIds || []
    return c.json(getSiteConfigForGroups(db, groupIds))
  } catch {
    return c.json(anonymousPublicSiteConfig())
  }
})

app.get('/api/settings/site', requireAuth, requireModuleSite, (c) => {
  const principal = c.get('principal')
  const requested = c.req.query('group_id')
  let groupId = requested != null && requested !== '' ? Number(requested) : null
  if (groupId == null || !Number.isFinite(groupId) || groupId <= 0) {
    groupId = principal.isSuperAdmin
      ? getDefaultGroupId(db)
      : (principal.groupIds[0] ?? getDefaultGroupId(db))
  }
  if (!assertGroupAccess(principal, groupId)) {
    return c.json({ error: '无权访问该组的站点设置' }, 403)
  }
  const config = getSiteConfigForGroup(db, groupId)
  return c.json({
    ...config,
    group_id: groupId,
    adminLoginPath: getAdminLoginSlug(db),
    adminLoginUrl: getAdminLoginHref(db),
    publicLoginPath: getPublicLoginSlug(db),
    publicLoginUrl: getPublicLoginHref(db),
  })
})

async function handleSaveSiteSettings(c) {
  const principal = c.get('principal')
  const body = await c.req.json().catch(() => ({}))
  let groupId = body.group_id != null ? Number(body.group_id) : null
  if (groupId == null || !Number.isFinite(groupId) || groupId <= 0) {
    groupId = principal.isSuperAdmin
      ? getDefaultGroupId(db)
      : (principal.groupIds[0] ?? null)
  }
  if (!groupId || !assertGroupAccess(principal, groupId)) {
    return c.json({ error: '无权保存该组的站点设置' }, 403)
  }
  try {
    let nextAdminSlug = getAdminLoginSlug(db)
    let nextPublicSlug = getPublicLoginSlug(db)

    if (body.admin_login_path !== undefined || body.adminLoginPath !== undefined) {
      const validated = validateAdminLoginSlug(body.admin_login_path ?? body.adminLoginPath)
      if (!validated.ok) throw new Error(validated.error)
      nextAdminSlug = validated.slug
    }
    if (body.public_login_path !== undefined || body.publicLoginPath !== undefined) {
      const validated = validatePublicLoginSlug(body.public_login_path ?? body.publicLoginPath)
      if (!validated.ok) throw new Error(validated.error)
      nextPublicSlug = validated.slug
    }
    if (nextAdminSlug === nextPublicSlug) {
      throw new Error('前后端登录路径不能相同')
    }

    if (body.admin_login_path !== undefined || body.adminLoginPath !== undefined) {
      saveAdminLoginSlug(db, body.admin_login_path ?? body.adminLoginPath)
    }
    if (body.public_login_path !== undefined || body.publicLoginPath !== undefined) {
      savePublicLoginSlug(db, body.public_login_path ?? body.publicLoginPath)
    }
    const saved = saveSiteConfigForGroup(db, groupId, body)
    return c.json({
      ...saved,
      group_id: groupId,
      adminLoginPath: getAdminLoginSlug(db),
      adminLoginUrl: getAdminLoginHref(db),
      publicLoginPath: getPublicLoginSlug(db),
      publicLoginUrl: getPublicLoginHref(db),
    })
  } catch (err) {
    return c.json({ error: err.message || '保存失败' }, 400)
  }
}

app.put('/api/settings/site', requireAuth, requireModuleSite, handleSaveSiteSettings)
app.post('/api/settings/site', requireAuth, requireModuleSite, handleSaveSiteSettings)

app.get('/api/settings/fonts', requireAuth, requireModuleFonts, (c) => {
  return c.json(getFontConfig(db))
})

async function handleSaveFontSettings(c) {
  const body = await c.req.json().catch(() => ({}))
  try {
    const saved = saveFontConfig(db, body)
    return c.json(saved)
  } catch (err) {
    return c.json({ error: err.message || '保存失败' }, 400)
  }
}

app.put('/api/settings/fonts', requireAuth, requireModuleFonts, handleSaveFontSettings)
app.post('/api/settings/fonts', requireAuth, requireModuleFonts, handleSaveFontSettings)

app.get('/api/meta', (c) => c.json({
  ok: true,
  version: 2,
  features: ['svg_templates', 'svg_template_files', 'table_templates', 'table_templates_empty', 'table_template_sample_rows', 'layout_presets', 'layout_preset_template_refs', 'layout_preset_page_nav_column', 'layout_preset_group', 'site_settings_by_group', 'certificates', 'certificate_row_presets', 'certificate_public_adornments', 'font_settings', 'site_settings', 'admin_login_path', 'public_login_path', 'data_transfer', 'media_upload', 'access_groups', 'visitor_auth', 'admin_modules', 'dashboard', 'account_profile', 'maintenance', 'auto_backup', 'backup_full_zip', 'cleanup_avatar_refs', 'backup_progress'],
  template_count: templateCount,
  site: getSiteConfig(db),
  adminLoginPath: getAdminLoginSlug(db),
  adminLoginUrl: getAdminLoginHref(db),
  publicLoginPath: getPublicLoginSlug(db),
  publicLoginUrl: getPublicLoginHref(db),
}))

const distDir = path.join(projectRoot, 'dist')
if (fs.existsSync(distDir) && isInstalled()) {
  app.use('*', async (c, next) => {
    const reqPath = c.req.path
    if (reqPath.startsWith('/api/')) return next()
    const adminLoginSlug = getAdminLoginSlug(db)
    const publicLoginSlug = getPublicLoginSlug(db)
    if (isBlockedDefaultAdminLoginPathname(adminLoginSlug, reqPath)) {
      return c.text('Not Found', 404)
    }
    if (isBlockedDefaultPublicLoginPathname(publicLoginSlug, reqPath)) {
      return c.text('Not Found', 404)
    }
    return serveStatic({
      root: distDir,
      rewriteRequestPath: (p) => {
        if (isAdminLoginPathname(adminLoginSlug, p)) return '/login.html'
        if (isPublicLoginPathname(publicLoginSlug, p)) return '/public-login.html'
        if (p === '/' || p === '') return '/index.html'
        if (isPseudoStaticCertPathname(p)) return '/index.html'
        if (!path.extname(p)) return p + '.html'
        return p
      },
    })(c, next)
  })
  console.log('[CAT API] 静态页面: ' + distDir)
} else if (!isInstalled()) {
  console.log('[CAT API] 未安装 → 请访问 /install.html 或运行 bash install.sh')
} else {
  console.warn('[CAT API] 未找到 dist/，请先 npm run build，或使用 npm run dev:web 开发前端')
}

if (!isInstalled()) {
  console.log('[CAT API] 安装向导: http://localhost:' + PORT + '/install.html')
}

console.log('[CAT API] http://localhost:' + PORT)
console.log('[CAT API] 管理员: ' + ADMIN_USERNAME + '（首次启动已写入数据库）')
console.log('[CAT API] SVG 模板数: ' + templateCount)
console.log('[CAT API] 表格模板：支持创建 0 列空模板')
console.log('[CAT API] 字体设置 API: GET/POST /api/settings/fonts · POST …/fonts/test · GET …/fonts/browse · 公开 GET /api/public/font-config')
console.log('[CAT API] 站点名称 API: GET/POST /api/settings/site · 公开 GET /api/public/site-config')
console.log('[CAT API] 数据迁移 API: GET /api/export/{table-templates,layout-presets,certificates} · POST /api/import/…')

startAutoBackupScheduler(db, projectRoot)

serve({ fetch: app.fetch, port: PORT })
