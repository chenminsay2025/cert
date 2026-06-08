/**
 * server/visitorTracking.js
 * 访客行为追踪与分析
 */

import { getClientIp } from './rateLimit.js'
import { getTokenFromRequest, getVisitorCookieName, verifySession } from './auth.js'
import { sqlGroupInClause } from './accessControl.js'

const MAX_FIELD_LENGTH = 500

function truncate(val, max = MAX_FIELD_LENGTH) {
  if (val == null) return ''
  return String(val).slice(0, max)
}

function nowIso() {
  return new Date().toISOString()
}

/** 从 cookie 中尝试解析访客信息（不抛异常，解析失败返回 null） */
async function tryResolveVisitor(db, req, secret) {
  try {
    const token = getTokenFromRequest(req, getVisitorCookieName())
    if (!token) return null
    const payload = await verifySession(token, secret)
    if (payload.typ !== 'visitor') return null
    const row = db.prepare('SELECT id, username FROM visitor_users WHERE id = ?').get(payload.sub)
    return row || null
  } catch {
    return null
  }
}

/**
 * 解析请求里的证书标题（从 cert_id 查 certificates 表）
 */
function resolveCertTitle(db, certId) {
  if (certId == null || Number.isNaN(Number(certId))) return ''
  const row = db.prepare('SELECT title FROM certificates WHERE id = ?').get(Number(certId))
  return row?.title || ''
}

/**
 * @param {import('hono').Hono} app
 * @param {{ db: import('better-sqlite3').Database, JWT_SECRET: string, requireAuth: Function }} opts
 */
export function registerTrackingRoutes(app, { db, JWT_SECRET, requireAuth }) {
  // ---- 记录活动（公开端点） ----
  app.post('/api/track', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const activityType = truncate(body.activity_type || '', 50)
      if (!activityType) return c.json({ ok: true }) // 静默忽略无效请求

      const visitor = await tryResolveVisitor(db, c.req.raw, JWT_SECRET)
      const visitorId = visitor?.id ?? (body.visitor_id != null ? Number(body.visitor_id) : null)
      const visitorName = truncate(visitor?.username || body.visitor_name || '', 100)
      const certId = body.cert_id != null ? Number(body.cert_id) : null
      const certTitle = truncate(body.cert_title || resolveCertTitle(db, certId), 200)
      const durationSeconds = Math.max(0, Number(body.duration_seconds || 0))
      const ipAddress = truncate(getClientIp(c), 45)
      const userAgent = truncate(c.req.header('user-agent') || '', MAX_FIELD_LENGTH)
      const referrer = truncate(body.referrer || c.req.header('referer') || '', MAX_FIELD_LENGTH)
      const details = truncate(
        typeof body.details === 'object' ? JSON.stringify(body.details) : String(body.details || ''),
        2000
      )

      db.prepare(`
        INSERT INTO visitor_activity_log
          (visitor_id, visitor_name, activity_type, cert_id, cert_title,
           ip_address, user_agent, referrer, duration_seconds, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        visitorId, visitorName, activityType, certId, certTitle,
        ipAddress, userAgent, referrer, durationSeconds, details,
        nowIso()
      )

      return c.json({ ok: true })
    } catch (err) {
      console.error('[TRACK] 记录活动失败:', err)
      return c.json({ ok: false, error: err.message }, 500)
    }
  })

  // ---- 分析查询（管理端） ----
  app.get('/api/analytics/visitors', requireAuth, (c) => {
    const principal = c.get('principal')
    const range = c.req.query('range') || '7d'
    const group = c.req.query('group') || 'day'

    let days = 7
    if (range === '30d') days = 30
    else if (range === '90d') days = 90

    const since = new Date(Date.now() - days * 86400 * 1000).toISOString()
    const gf = sqlGroupInClause(principal)

    // 摘要统计
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total_events,
        COUNT(DISTINCT COALESCE(NULLIF(ip_address, ''), NULLIF(visitor_name, ''), 'anon')) AS unique_visitors,
        SUM(CASE WHEN activity_type LIKE '%download' THEN 1 ELSE 0 END) AS total_downloads,
        AVG(CASE WHEN duration_seconds > 0 AND duration_seconds < 86400 THEN duration_seconds ELSE NULL END) AS avg_duration
      FROM visitor_activity_log
      WHERE created_at >= ?
    `).get(since)

    // 按日期聚合
    const dateFormat = group === 'hour'
      ? "strftime('%Y-%m-%dT%H:00:00', created_at)"
      : "date(created_at)"
    const dailyStats = db.prepare(`
      SELECT
        ${dateFormat} AS date_key,
        COUNT(*) AS pv,
        COUNT(DISTINCT COALESCE(NULLIF(ip_address, ''), NULLIF(visitor_name, ''), 'anon')) AS uv,
        SUM(CASE WHEN activity_type LIKE '%download' THEN 1 ELSE 0 END) AS downloads,
        ROUND(AVG(CASE WHEN duration_seconds > 0 AND duration_seconds < 86400 THEN duration_seconds ELSE NULL END), 1) AS avg_seconds
      FROM visitor_activity_log
      WHERE created_at >= ?
      GROUP BY date_key
      ORDER BY date_key ASC
    `).all(since)

    // 热门证书 TOP 20（按组过滤）
    let topCerts = []
    if (gf.clause) {
      topCerts = db.prepare(`
        SELECT
          al.cert_id,
          al.cert_title,
          SUM(CASE WHEN al.activity_type = 'page_view' THEN 1 ELSE 0 END) AS views,
          SUM(CASE WHEN al.activity_type LIKE '%download' THEN 1 ELSE 0 END) AS downloads
        FROM visitor_activity_log al
        JOIN certificates c ON c.id = al.cert_id
        WHERE al.created_at >= ? AND al.cert_id IS NOT NULL${gf.clause.replace(/AND\s+group_id/, 'AND c.group_id')}
        GROUP BY al.cert_id
        ORDER BY views DESC
        LIMIT 20
      `).all(since, ...gf.params)
    } else {
      // 超管无视组过滤
      topCerts = db.prepare(`
        SELECT
          cert_id, cert_title,
          SUM(CASE WHEN activity_type = 'page_view' THEN 1 ELSE 0 END) AS views,
          SUM(CASE WHEN activity_type LIKE '%download' THEN 1 ELSE 0 END) AS downloads
        FROM visitor_activity_log
        WHERE created_at >= ? AND cert_id IS NOT NULL
        GROUP BY cert_id
        ORDER BY views DESC
        LIMIT 20
      `).all(since)
    }

    // 最近活动
    const recentActivity = db.prepare(`
      SELECT id, visitor_name, activity_type, cert_title, ip_address,
             duration_seconds, created_at
      FROM visitor_activity_log
      WHERE created_at >= ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(since)

    return c.json({
      ok: true,
      summary: {
        total_events: Number(summary?.total_events || 0),
        unique_visitors: Number(summary?.unique_visitors || 0),
        total_downloads: Number(summary?.total_downloads || 0),
        avg_duration_seconds: Number(summary?.avg_duration || 0),
      },
      daily_stats: dailyStats.map((r) => ({
        ...r,
        pv: Number(r.pv),
        uv: Number(r.uv),
        downloads: Number(r.downloads),
        avg_seconds: r.avg_seconds != null ? Number(r.avg_seconds) : null,
      })),
      top_certs: topCerts.map((r) => ({
        cert_id: Number(r.cert_id),
        cert_title: r.cert_title,
        views: Number(r.views),
        downloads: Number(r.downloads),
      })),
      recent_activity: recentActivity.map((r) => ({
        id: Number(r.id),
        visitor_name: r.visitor_name,
        activity_type: r.activity_type,
        cert_title: r.cert_title,
        ip_address: r.ip_address,
        duration_seconds: Number(r.duration_seconds),
        created_at: r.created_at,
      })),
    })
  })
}
