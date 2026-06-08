/**
 * src/admin/visitorAnalytics.js
 * 访客行为分析面板
 */

const ACTIVITY_LABELS = {
  login: '登录',
  page_visit: '访问页面',
  page_view: '浏览证书',
  pdf_download: '下载 PDF',
  svg_download: '下载 SVG',
}

function formatSeconds(sec) {
  if (sec == null || sec === 0) return '—'
  if (sec < 60) return `${Math.round(sec)} 秒`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分`
  return `${(sec / 3600).toFixed(1)} 时`
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function activityBadge(type) {
  const label = ACTIVITY_LABELS[type] || type
  const cls = type.includes('download') ? 'va-badge--download' : type === 'login' ? 'va-badge--login' : 'va-badge--view'
  return `<span class="va-badge ${cls}">${label}</span>`
}

function formatIp(ip) {
  if (!ip || ip === '127.0.0.1') return '本地'
  // 脱敏显示：只显示前两段
  const parts = ip.split('.')
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.***.***`
  return ip
}

/**
 * @param {HTMLElement} container
 */
export async function mountVisitorAnalyticsPanel(container) {
  container.innerHTML = `
    <div class="wp-settings-panel-inner visitor-analytics-panel">
      <div class="va-header">
        <h3>访客分析</h3>
        <div class="va-controls">
          <label class="va-range-label">
            <select id="va-range" class="va-select">
              <option value="7d">最近 7 天</option>
              <option value="30d" selected>最近 30 天</option>
              <option value="90d">最近 90 天</option>
            </select>
          </label>
          <button type="button" class="button button-sm" id="va-refresh">刷新</button>
        </div>
      </div>

      <div class="va-summary-cards" id="va-summary">
        <div class="va-card va-card--loading"><span class="va-card-value">—</span><span class="va-card-label">加载中…</span></div>
      </div>

      <div class="va-section">
        <h4 class="va-section-title">每日趋势</h4>
        <div class="va-chart" id="va-chart">
          <p class="va-empty">加载中…</p>
        </div>
      </div>

      <div class="va-grid">
        <div class="va-section">
          <h4 class="va-section-title">热门证书 TOP 20</h4>
          <div class="va-table-wrap" id="va-top-certs">
            <p class="va-empty">加载中…</p>
          </div>
        </div>
        <div class="va-section">
          <h4 class="va-section-title">最近活动</h4>
          <div class="va-table-wrap" id="va-recent">
            <p class="va-empty">加载中…</p>
          </div>
        </div>
      </div>
    </div>
  `

  const rangeEl = container.querySelector('#va-range')
  const refreshBtn = container.querySelector('#va-refresh')

  async function load() {
    const range = rangeEl?.value || '30d'
    try {
      const res = await fetch(`/api/analytics/visitors?range=${range}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok || !data?.ok) throw new Error(data?.error || '加载失败')
      renderSummary(data.summary)
      renderChart(data.daily_stats || [])
      renderTopCerts(data.top_certs || [])
      renderRecent(data.recent_activity || [])
    } catch (err) {
      container.querySelector('#va-summary').innerHTML =
        `<p class="va-error">加载失败: ${err.message}</p>`
    }
  }

  function renderSummary(s) {
    const cards = [
      { value: s?.total_events ?? 0, label: '总访问' },
      { value: s?.unique_visitors ?? 0, label: '独立访客' },
      { value: s?.total_downloads ?? 0, label: '下载次数' },
      { value: formatSeconds(s?.avg_duration_seconds), label: '平均时长' },
    ]
    container.querySelector('#va-summary').innerHTML = cards.map((c) => `
      <div class="va-card">
        <span class="va-card-value">${c.value}</span>
        <span class="va-card-label">${c.label}</span>
      </div>
    `).join('')
  }

  function renderChart(stats) {
    const el = container.querySelector('#va-chart')
    if (!stats.length) {
      el.innerHTML = '<p class="va-empty">暂无数据</p>'
      return
    }

    // 和趋势图不一样，只框在一个 max 里面防止极值吃掉柱子
    const maxPv = Math.max(...stats.map((s) => s.pv), 1)
    const maxDownloads = Math.max(...stats.map((s) => s.downloads), 1)
    const maxAll = Math.max(maxPv, maxDownloads)

    const bars = stats.map((s) => {
      const dateLabel = s.date_key.includes('T')
        ? s.date_key.slice(11, 16)
        : s.date_key.slice(5) // MM-DD
      const pvPct = maxAll > 0 ? (s.pv / maxAll) * 100 : 0
      const dlPct = maxAll > 0 ? (s.downloads / maxAll) * 100 : 0
      return `
        <div class="va-chart-col" title="${dateLabel} 访问 ${s.pv} · 下载 ${s.downloads}">
          <div class="va-chart-bar-stack">
            <div class="va-chart-bar va-chart-bar--pv" style="height:${pvPct}%"></div>
            <div class="va-chart-bar va-chart-bar--dl" style="height:${dlPct}%"></div>
          </div>
          <span class="va-chart-label">${dateLabel}</span>
        </div>`
    }).join('')

    el.innerHTML = `
      <div class="va-chart-legend">
        <span class="va-legend-dot va-legend-dot--pv"></span> 访问
        <span class="va-legend-dot va-legend-dot--dl"></span> 下载
      </div>
      <div class="va-chart-bars">${bars}</div>
    `
  }

  function renderTopCerts(certs) {
    const el = container.querySelector('#va-top-certs')
    if (!certs.length) {
      el.innerHTML = '<p class="va-empty">暂无数据</p>'
      return
    }
    const rows = certs.map((c, i) => `
      <tr>
        <td class="va-cell-rank">${i + 1}</td>
        <td class="va-cell-title" title="${escapeHtml(c.cert_title)}">${escapeHtml(c.cert_title || '—')}</td>
        <td class="va-cell-num">${c.views}</td>
        <td class="va-cell-num">${c.downloads}</td>
      </tr>
    `).join('')
    el.innerHTML = `
      <table class="va-table">
        <thead><tr><th>#</th><th>证书</th><th>浏览</th><th>下载</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `
  }

  function renderRecent(items) {
    const el = container.querySelector('#va-recent')
    if (!items.length) {
      el.innerHTML = '<p class="va-empty">暂无数据</p>'
      return
    }
    const rows = items.map((r) => `
      <tr>
        <td class="va-cell-time">${formatTime(r.created_at)}</td>
        <td>${escapeHtml(r.visitor_name || '匿名')}</td>
        <td>${activityBadge(r.activity_type)}</td>
        <td class="va-cell-title">${escapeHtml(r.cert_title || '—')}</td>
        <td class="va-cell-ip">${formatIp(r.ip_address)}</td>
      </tr>
    `).join('')
    el.innerHTML = `
      <table class="va-table">
        <thead><tr><th>时间</th><th>访客</th><th>活动</th><th>证书</th><th>IP</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `
  }

  function escapeHtml(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return String(str || '').replace(/[&<>"']/g, (c) => map[c])
  }

  rangeEl?.addEventListener('change', load)
  refreshBtn?.addEventListener('click', load)

  await load()
}
