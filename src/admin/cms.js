import { api } from '../api/client.js'
import { mountTemplatesPanel } from './templates.js'
import { mountTableTemplatesPanel } from './tableTemplates.js'
import { mountLayoutPresetsPanel } from './layoutPresets.js'
import { mountFontsPanel } from './fonts.js'
import { mountSiteSettingsPanel } from './siteSettings.js'
import { mountMaintenancePanel } from './maintenance.js'
import { mountOverviewPanel } from './overview.js'
import { userCanAccessModule } from './adminModules.js'
import { mountAccessManagePanel } from './accessManage.js'
import { loadAccessibleGroups, invalidateGroupCache, defaultGroupIdForUser } from './groupUtils.js'
import { groupBadgeHtml } from './groupSelectorUi.js'
import {
  getSiteConfig,
  setSiteConfig,
  siteText,
  applySiteTextToDom,
  applyDocumentTitle,
  untitledName,
  buildPublicCertUrl,
  resolvePublicPageUrl,
  normalizeSiteConfig,
} from '../siteConfig.js'
import {
  normalizePublicCertSlug,
  splitPublicCertUrlSuffix,
} from '../publicCertUrl.js'
import {
  customSampleDisplayFromPreset,
  sanitizeCertificateRows,
  resolveCertificateLayoutOverrides,
  sampleAdornmentsFromPreset,
  resolveTemplateColumnOrder,
} from '../presetSampleRow.js'
import { pageSizeFromPreset } from '../pageSize.js'
import {
  downloadJsonFile,
  readJsonFile,
  askImportConflictMode,
  alertImportDetails,
  formatImportResultMessage,
  dataTransferMenuHtml,
  setupDataTransferMenu,
  setDataTransferExportDisabled,
} from './dataTransferUi.js'
import { mountAccountCenter } from './accountCenter.js'
import { redirectToAdminLogin, invalidateAdminLoginHrefCache } from '../adminLoginRedirect.js'
import { invalidatePublicLoginHrefCache } from '../publicLoginRedirect.js'
import { bootLayoutSwitchDebugHint, logLayoutSwitch, warnLayoutSwitch } from '../layoutSwitchDebug.js'
import { pruneLayoutOverridesForTable, applyTableTemplateScopeFlag } from '../layoutBinding.js'
import { findBestPresetMatch } from '../presetNameMatch.js'
import { searchTextIncludes } from '../searchNormalize.js'

/**
 * @param {HTMLElement} root
 * @param {{
 *   user: { id: number, username: string, is_super_admin?: boolean, group_ids?: number[] },
 *   siteConfig?: import('../siteConfig.js').SiteConfig,
 *   getEditorState: () => object,
 *   loadEditorState: (state: object) => Promise<void> | void,
 *   applyPresetLayoutContext?: (bundle: object, options?: object) => Promise<void>,
 *   invalidateRowPresetCache?: (rowIndex: number) => void,
 *   applyTableTemplate?: (columns: string[]) => void,
 *   setRowPresetId?: (rowIndex: number, presetId: number | null) => void,
 *   setAllRowPresetIds?: (presetId: number | null) => void,
 *   setRowPresetIds?: (presetIds: Array<number | null>) => void,
 *   getRowPresetIds?: () => Array<number | null>,
 *   onTableRefreshNeeded?: () => void,
 *   refreshPreviewForRow?: (rowIndex: number, options?: object) => Promise<void>,
 *   getPreviewDisplayedRow?: () => number,
 *   onStatus?: (msg: string) => void,
 * }} options
 */
export function mountCmsBar(root, options) {
  let currentCertId = null
  let currentStatus = 'draft'
  /** @type {number | null} */
  let currentPresetId = null
  /** @type {number | null} 编辑器当前已加载的布局模板（可能为某行的专用布局） */
  let loadedPresetId = null
  /** @type {number | null} */
  let currentPresetSvgId = null
  /** @type {number | null} */
  let currentPresetTableTemplateId = null
  let presets = []
  /** @type {{ id: number, name: string, is_default?: boolean }[]} */
  let templates = []
  /** @type {{ id: number, name: string, columns?: string[] }[]} */
  let tableTemplates = []
  /** @type {{ id: number, title: string, status: string, group_name?: string | null, group_id?: number | null, updated_at?: string, search_text?: string }[]} */
  let certificates = []
  let certFilter = 'all'
  /** @type {{ all: number, draft: number, published: number, trash: number }} */
  let certCounts = { all: 0, draft: 0, published: 0, trash: 0 }
  let certSearch = ''
  /** @type {'none' | 'group' | 'status' | 'month'} */
  let certGroupBy = 'none'
  /** @type {Set<number>} */
  let certSelectedIds = new Set()
  let saveTimer = null
  let dirty = false
  /** 本地新建、尚未首次保存到服务器的证书 */
  let isDraftNewCert = false

  const params = new URLSearchParams(window.location.search)
  const initialCertId = params.get('cert') ? Number(params.get('cert')) : null
  const initialView = params.get('view') || (initialCertId ? 'edit' : 'overview')
  let currentView = 'list'
  /** @type {{ init: () => Promise<void>, repaint?: () => Promise<void> } | null} */
  let templatesPanel = null
  /** @type {{ init: () => Promise<void>, repaint?: () => Promise<void> } | null} */
  let tableTemplatesPanel = null
  /** @type {{ init: () => Promise<void>, repaint?: () => Promise<void> } | null} */
  let layoutPresetsPanel = null
  /** @type {{ init: () => Promise<void> } | null} */
  let fontsPanel = null
  /** @type {{ init: () => Promise<void> } | null} */
  let siteSettingsPanel = null
  /** @type {{ init: () => Promise<void> } | null} */
  let accessManagePanel = null
  /** @type {{ init: () => Promise<void>, refresh?: () => Promise<void> } | null} */
  let overviewPanel = null
  /** @type {{ init: () => Promise<void> } | null} */
  let maintenancePanel = null
  /** @type {{ id: number, name: string }[]} */
  let accessGroups = []
  /** @type {number | null} */
  let currentCertGroupId = null
  /** @type {string | null} 自定义前端链接后缀；null 表示使用证书编号 */
  let currentPublicSlug = null
  /** 用户是否手动改过链接后缀 */
  let publicSlugTouched = false
  /** @type {Map<number, import('../siteConfig.js').SiteConfig>} */
  const groupSiteConfigCache = new Map()

  const siteCfg = () => getSiteConfig()
  const E = () => siteCfg().entityLabel

  function invalidateGroupSiteConfigCache(groupId) {
    if (groupId != null && Number.isFinite(Number(groupId))) {
      groupSiteConfigCache.delete(Number(groupId))
      return
    }
    groupSiteConfigCache.clear()
  }

  function resolveUngroupedGroupId() {
    const row = accessGroups.find((g) => g.slug === 'ungrouped' || g.name === '未分组')
    return row?.id != null ? Number(row.id) : null
  }

  function resolveEffectiveCertGroupId(groupId = currentCertGroupId) {
    const direct = groupId != null ? Number(groupId) : null
    if (direct && Number.isFinite(direct) && direct > 0) return direct
    if (currentCertId) {
      const cert = certificates.find((c) => Number(c.id) === Number(currentCertId))
      const fromCert = cert?.group_id != null ? Number(cert.group_id) : null
      if (fromCert && Number.isFinite(fromCert) && fromCert > 0) return fromCert
    }
    if (currentPresetId) {
      const preset = presets.find((p) => Number(p.id) === Number(currentPresetId))
      const fromPreset = preset?.group_id != null ? Number(preset.group_id) : null
      if (fromPreset && Number.isFinite(fromPreset) && fromPreset > 0) return fromPreset
    }
    const fallback = defaultGroupIdForUser(options.user, accessGroups)
    if (fallback && Number.isFinite(Number(fallback)) && Number(fallback) > 0) {
      return Number(fallback)
    }
    return resolveUngroupedGroupId()
  }

  function rememberPresetMeta(preset) {
    if (!preset?.id) return
    const pid = Number(preset.id)
    const idx = presets.findIndex((p) => Number(p.id) === pid)
    if (idx >= 0) {
      presets[idx] = { ...presets[idx], ...preset, id: pid, group_id: preset.group_id ?? presets[idx].group_id ?? null }
    }
  }

  async function syncCertGroupFromLayoutPreset(preset) {
    if (!preset) return
    rememberPresetMeta(preset)
    const presetGroupId = preset.group_id != null ? Number(preset.group_id) : null
    if (presetGroupId && Number.isFinite(presetGroupId) && presetGroupId > 0) {
      currentCertGroupId = presetGroupId
    } else if (isDraftNewCert && !currentCertId) {
      currentCertGroupId = null
    }
    const gid = resolveEffectiveCertGroupId()
    if (gid) await fetchSiteConfigForGroupId(gid)
  }

  function resolveCertRowGroupId(c) {
    const gid = c?.group_id != null ? Number(c.group_id) : null
    if (gid && Number.isFinite(gid) && gid > 0) return gid
    if (c?.preset_id != null) {
      const preset = presets.find((p) => Number(p.id) === Number(c.preset_id))
      const fromPreset = preset?.group_id != null ? Number(preset.group_id) : null
      if (fromPreset && Number.isFinite(fromPreset) && fromPreset > 0) return fromPreset
    }
    const fallback = defaultGroupIdForUser(options.user, accessGroups)
    if (fallback && Number(fallback) > 0) return Number(fallback)
    return resolveUngroupedGroupId()
  }

  async function fetchSiteConfigForGroupId(gid) {
    const id = gid != null ? Number(gid) : null
    if (!id || !Number.isFinite(id) || id <= 0) {
      return normalizeSiteConfig(getSiteConfig())
    }
    if (groupSiteConfigCache.has(id)) return groupSiteConfigCache.get(id)
    try {
      const data = await api.getSiteSettings(id)
      const cfg = normalizeSiteConfig(data)
      groupSiteConfigCache.set(id, cfg)
      return cfg
    } catch (err) {
      console.warn('[CMS] 加载访问组站点设置失败', id, err)
      return normalizeSiteConfig(getSiteConfig())
    }
  }

  async function resolveSiteConfigForCertGroup(groupId) {
    return fetchSiteConfigForGroupId(resolveEffectiveCertGroupId(groupId))
  }

  async function preloadPublishedCertLinkConfigs(certs = certificates) {
    const groupIds = [...new Set(
      certs
        .filter((c) => !isCertTrashed(c))
        .map((c) => resolveCertRowGroupId(c))
        .filter(Boolean),
    )]
    await Promise.all(groupIds.map((gid) => fetchSiteConfigForGroupId(gid)))
  }

  function publicCertUrlForRow(c) {
    if (isCertTrashed(c)) return ''
    const gid = resolveCertRowGroupId(c)
    const cfg = gid && groupSiteConfigCache.has(gid) ? groupSiteConfigCache.get(gid) : null
    return cfg ? buildPublicCertUrl({ id: c.id, publicSlug: c.public_slug || null }, cfg) : ''
  }

  function suggestPublicSlugFromTitle(title) {
    return normalizePublicCertSlug(title) || null
  }

  function plannedDraftPublicSlug() {
    if (currentPublicSlug) return currentPublicSlug
    return suggestPublicSlugFromTitle(titleInput?.value || '')
  }

  /** 新建证书链接预览：无可用后缀时与站点设置示例一致，使用编号 1 */
  function draftPreviewCertRef() {
    if (currentPublicSlug) return { id: null, publicSlug: currentPublicSlug }
    const fromTitle = suggestPublicSlugFromTitle(titleInput?.value || '')
    if (fromTitle) return { id: null, publicSlug: fromTitle }
    return { id: 1, publicSlug: null }
  }

  function isDraftPublicLinkPreview() {
    return isDraftNewCert && !currentCertId
  }

  function resolvePublicCertLinkRef() {
    if (currentPublicSlug) {
      return { id: currentCertId, publicSlug: currentPublicSlug }
    }
    if (currentCertId) {
      return { id: currentCertId, publicSlug: null }
    }
    return { id: null, publicSlug: plannedDraftPublicSlug() }
  }

  function effectivePublicSlugSuffix() {
    if (currentPublicSlug) return currentPublicSlug
    if (currentCertId) return String(currentCertId)
    return suggestPublicSlugFromTitle(titleInput?.value || '') || '1'
  }

  async function syncPublicCertLink() {
    const wrap = document.getElementById('cms-public-cert-link-wrap')
    const el = document.getElementById('cms-public-cert-link')
    if (!wrap || !el) return
    if (currentView !== 'edit') {
      wrap.hidden = true
      return
    }
    if (isNewCertAwaitingPreset()) {
      wrap.hidden = true
      return
    }
    const groupId = resolveEffectiveCertGroupId()
    const cfg = await fetchSiteConfigForGroupId(groupId)
    const published = currentStatus === 'published'

    if (isDraftPublicLinkPreview()) {
      const ref = draftPreviewCertRef()
      const url = buildPublicCertUrl(ref, cfg)
      const label = formatPublicCertLinkLabel(url)
      const usesIdExample = !currentPublicSlug && !suggestPublicSlugFromTitle(titleInput?.value || '')
      const note = usesIdExample ? '（预定·编号示例）' : '（预定）'
      wrap.hidden = !url
      el.hidden = !url
      el.dataset.url = url || ''
      el.textContent = label ? `${label}${note}` : ''
      el.classList.add('is-draft', 'is-link-preview')
      el.title = usesIdExample
        ? `${label}${note}\n与站点设置「前端链接示例」相同格式\n保存后使用证书编号；自定义后缀若冲突则改用编号\n点击复制示例地址`
        : `${label}${note}\n保存前预览，保存后生效\n若后缀已被占用将改用证书编号\n点击复制预定地址`
      return
    }

    el.classList.remove('is-link-preview')
    const ref = resolvePublicCertLinkRef()
    const url = buildPublicCertUrl(ref, cfg)
    wrap.hidden = !url
    el.hidden = !url
    el.dataset.url = url || ''
    el.textContent = url ? formatPublicCertLinkLabel(url) : ''
    el.classList.toggle('is-draft', !published)
    const label = url ? formatPublicCertLinkLabel(url) : ''
    el.title = published
      ? `${label}\n点击复制`
      : `${label}\n预览链接，发布后对外生效\n点击复制`
  }

  function formatPublicCertLinkLabel(url) {
    if (!url) return ''
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    try {
      let u
      if (url.startsWith('?')) {
        u = new URL(origin)
        u.search = url
      } else if (url.startsWith('/')) {
        u = new URL(origin)
        const q = url.indexOf('?')
        u.pathname = q >= 0 ? url.slice(0, q) : url
        u.search = q >= 0 ? url.slice(q) : ''
      } else {
        u = new URL(url.includes('://') ? url : `https://${url}`)
      }
      return `${u.host}${u.pathname}${u.search}${u.hash}`
    } catch {
      return url.replace(/^https?:\/\//i, '')
    }
  }

  async function copyTextToClipboard(text, okMessage = '链接已复制') {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      status(okMessage)
    } catch {
      status('复制失败，请手动选择链接')
    }
  }

  function canModule(key) {
    return userCanAccessModule(options.user, key)
  }

  function applyNavModuleVisibility() {
    root.querySelectorAll('.wp-nav-link[data-module]').forEach((el) => {
      const mod = el.dataset.module
      el.hidden = !canModule(mod)
    })
    for (const sectionId of ['cms-nav-templates', 'cms-nav-settings']) {
      const section = root.querySelector(`#${sectionId}`)
      if (!section) continue
      const visible = [...section.querySelectorAll('.wp-nav-link[data-module]')].some((el) => !el.hidden)
      section.hidden = !visible
    }
  }

  function applySiteBranding(cfg = siteCfg()) {
    setSiteConfig(cfg)
    applyDocumentTitle()
    const markEl = root.querySelector('#cms-brand-mark')
    const titleEl = root.querySelector('#cms-brand-title')
    if (markEl) markEl.textContent = cfg.brandMark
    if (titleEl) titleEl.textContent = cfg.appName
    applySiteTextToDom(root, cfg)
    const previewTitle = document.getElementById('preview-panel-title')
    if (previewTitle) previewTitle.textContent = siteText('entityPreview', cfg)
    syncPublicPageNavLink()
    void syncPublicCertLink()
  }

  function syncCertFilterUi() {
    root.querySelectorAll('.wp-pill[data-filter]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.filter === certFilter)
    })
    root.querySelectorAll('.wp-nav-filter-link[data-cert-filter]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.certFilter === certFilter)
    })
    updateCertFilterBadges()
  }

  function updateCertFilterBadges() {
    const labels = {
      all: '全部',
      draft: '草稿',
      published: '已发布',
      trash: '回收站',
    }
    root.querySelectorAll('.wp-pill[data-filter]').forEach((btn) => {
      const key = btn.dataset.filter
      if (!key || labels[key] == null) return
      const count = certCounts[key] ?? 0
      btn.innerHTML = `<span class="wp-pill-label">${labels[key]}</span><span class="wp-pill-badge" aria-label="${count} 项">${count}</span>`
    })
    root.querySelectorAll('.wp-nav-filter-link[data-cert-filter]').forEach((btn) => {
      const key = btn.dataset.certFilter
      if (!key || labels[key] == null) return
      const count = certCounts[key] ?? 0
      const label = labels[key]
      btn.textContent = count > 0 ? `${label} (${count})` : label
    })
  }

  async function refreshCertCounts() {
    try {
      const [allRes, trashRes] = await Promise.all([
        api.listCertificates('all'),
        api.listCertificates('trash'),
      ])
      const all = allRes.certificates || []
      certCounts = {
        all: all.length,
        draft: all.filter((c) => c.status === 'draft').length,
        published: all.filter((c) => c.status === 'published').length,
        trash: (trashRes.certificates || []).length,
      }
      updateCertFilterBadges()
    } catch {
      // 角标失败不影响列表
    }
  }

  function syncPublicPageNavLink() {
    const link = root.querySelector('.wp-nav-external[href]')
    if (link) link.href = resolvePublicPageUrl()
  }

  function setCertFilter(filter) {
    certFilter = filter || 'all'
    syncCertFilterUi()
    certSelectedIds.clear()
    refreshCertList().catch((err) => status(err.message || '加载列表失败'))
  }

  if (options.siteConfig) setSiteConfig(options.siteConfig)

  root.innerHTML = `
    <div class="wp-admin-shell">
      <div class="wp-admin-layout">
        <aside class="wp-admin-menu" aria-label="管理菜单" id="wp-admin-menu">
          <button type="button" class="wp-sidebar-collapse-btn" id="wp-sidebar-collapse-btn" title="收起/展开侧栏" aria-label="收起侧栏">◀</button>
          <div class="wp-sidebar-brand">
            <span class="wp-brand-mark" id="cms-brand-mark" aria-hidden="true">${escapeHtml(siteCfg().brandMark)}</span>
            <div class="wp-brand-text">
              <span class="wp-brand-title" id="cms-brand-title">${escapeHtml(siteCfg().appName)}</span>
              <span class="wp-brand-sub">管理后台</span>
            </div>
          </div>

          <nav class="wp-sidebar-nav" aria-label="功能导航">
            <div class="wp-nav-section wp-nav-section--overview">
              <span class="wp-nav-section-label">系统</span>
              <button type="button" class="wp-nav-link" data-view="overview" data-collapse-icon="📊">概览</button>
            </div>

            <div class="wp-nav-section wp-nav-section--content">
              <span class="wp-nav-section-label" id="cms-nav-entity-list-label" data-site-text="entityList">${escapeHtml(siteText('entityList'))}</span>
              <button type="button" class="wp-nav-link" data-view="list" data-cert-filter="all" data-collapse-icon="📋">查看全部</button>
              <div class="wp-nav-quick-actions">
                <button type="button" class="wp-nav-quick-btn cms-cert-new-trigger" data-site-text="newEntity">${escapeHtml(siteText('newEntity'))}</button>
                <div class="wp-nav-filter-group" role="tablist" aria-label="证书筛选">
                  <button type="button" class="wp-nav-filter-link" data-cert-filter="draft">草稿</button>
                  <button type="button" class="wp-nav-filter-link" data-cert-filter="published">已发布</button>
                  <button type="button" class="wp-nav-filter-link" data-cert-filter="trash">回收站</button>
                </div>
              </div>
            </div>

            <div class="wp-nav-section" id="cms-nav-templates">
              <span class="wp-nav-section-label">模板</span>
              <button type="button" class="wp-nav-link" data-view="templates" data-module="templates" data-collapse-icon="🎨">SVG 模板库</button>
              <button type="button" class="wp-nav-link" data-view="table-templates" data-module="table-templates" data-collapse-icon="📐">表格模板库</button>
              <button type="button" class="wp-nav-link" data-view="layout-presets" data-module="layout-presets" data-collapse-icon="📏">布局模板库</button>
            </div>

            <div class="wp-nav-section" id="cms-nav-settings">
              <span class="wp-nav-section-label">设置</span>
              <button type="button" class="wp-nav-link" data-view="site" data-module="site" data-collapse-icon="⚙️">站点设置</button>
              <button type="button" class="wp-nav-link" data-view="fonts" data-module="fonts" data-collapse-icon="🔤">字体源</button>
              <button type="button" class="wp-nav-link" data-view="maintenance" data-module="maintenance" data-collapse-icon="🗄️">数据维护</button>
              <button type="button" class="wp-nav-link" data-view="access" data-module="access" data-collapse-icon="🔐">权限管理</button>
              <button type="button" class="wp-nav-link" data-view="analytics" data-collapse-icon="📈">访客分析</button>
            </div>

            <div class="wp-nav-section">
              <span class="wp-nav-section-label">快速访问</span>
              <a class="wp-nav-link wp-nav-external" href="/" target="_blank" rel="noopener" data-collapse-icon="🌐">前端 ↗</a>
            </div>
          </nav>

          <div class="wp-sidebar-spacer" aria-hidden="true"></div>

          <div class="wp-sidebar-footer">
            <button type="button" class="wp-user-chip wp-user-chip--account" id="cms-open-account" title="账户中心">
              <span class="wp-user-avatar${options.user.avatar_url ? ' has-image' : ''}" id="cms-user-avatar">${options.user.avatar_url ? `<img src="${escapeAttr(options.user.avatar_url)}" alt="" class="wp-user-avatar-img" />` : escapeHtml(options.user.username.slice(0, 1).toUpperCase())}</span>
              <div class="wp-user-text">
                <span class="wp-user-name" id="cms-user-name">${escapeHtml(options.user.username)}</span>
                <span class="wp-user-role" id="cms-user-role">${escapeHtml(formatAdminRoleLabel(options.user))}</span>
              </div>
              <span class="wp-user-account-hint" aria-hidden="true">账户</span>
            </button>
            <button type="button" class="wp-btn-ghost" id="cms-logout">退出登录</button>
          </div>
        </aside>

        <div class="wp-admin-content">
          <div class="wp-view-stage" id="cms-view-stage">
            <section class="wp-view-page" id="cms-view-overview" data-view="overview" aria-label="概览">
              <div class="wp-settings-host" id="cms-panel-overview"></div>
            </section>

            <section class="wp-view-page" id="cms-view-list" data-view="list" data-site-aria="entityList">
              <div class="wp-cert-list-view">
                <header class="wp-list-header">
                  <div>
                    <h2 class="wp-list-title" data-site-text="entityList">${escapeHtml(siteText('entityList'))}</h2>
                    <p class="wp-list-desc" data-site-text="entityListDesc">${escapeHtml(siteText('entityListDesc'))}</p>
                  </div>
                </header>

                <div class="wp-list-toolbar">
                  <div class="wp-list-toolbar-primary">
                    <button type="button" class="button button-primary wp-list-new-btn" id="cms-cert-new" data-site-text="newEntity">${escapeHtml(siteText('newEntity'))}</button>
                    <div class="wp-filter-pills wp-filter-pills--light wp-filter-pills--cert" role="tablist" data-site-aria="filterEntity">
                      <button type="button" class="wp-pill is-active" data-filter="all">全部</button>
                      <button type="button" class="wp-pill" data-filter="draft">草稿</button>
                      <button type="button" class="wp-pill" data-filter="published">已发布</button>
                      <button type="button" class="wp-pill" data-filter="trash">回收站</button>
                    </div>
                  </div>
                  <input type="search" id="cms-cert-search" class="wp-list-search" data-site-placeholder="searchEntityTitle" placeholder="${escapeHtml(siteText('searchEntityTitle'))}" />
                  <label class="wp-list-group-by">
                    <span class="wp-list-group-by-label">分组</span>
                    <select id="cms-cert-group-by" class="wp-select wp-select-inline">
                      <option value="none">不分组</option>
                      <option value="group">按分组名</option>
                      <option value="status">按状态</option>
                      <option value="month">按月份</option>
                    </select>
                  </label>
                  ${dataTransferMenuHtml({ prefix: 'cms-cert', exportLabel: '导出所选', exportDisabled: true })}
                </div>

                <div class="wp-list-batch-bar" id="cms-cert-batch-bar" hidden>
                  <label class="wp-cert-select-all-label">
                    <input type="checkbox" id="cms-cert-select-all" class="wp-cert-select-all" />
                    <span>全选当前页</span>
                  </label>
                  <span class="wp-cert-selection-count" id="cms-cert-selection-count" aria-live="polite"></span>
                  <div class="wp-list-batch-actions">
                    <button type="button" class="button button-sm button-primary" id="cms-cert-batch-edit" disabled>编辑</button>
                    <button type="button" class="button button-sm" id="cms-cert-batch-copy" disabled>复制</button>
                    <button type="button" class="button button-sm" id="cms-cert-batch-group" disabled>设置分组</button>
                    <button type="button" class="button button-sm" id="cms-cert-batch-restore" disabled hidden>恢复</button>
                    <button type="button" class="button button-sm button-danger" id="cms-cert-batch-delete" disabled>移到回收站</button>
                    <button type="button" class="button button-sm button-danger" id="cms-cert-batch-purge" disabled hidden>永久删除</button>
                  </div>
                </div>

                <div class="wp-list-table-wrap">
                  <table class="wp-cert-table" id="cms-cert-table">
                    <thead>
                      <tr>
                        <th scope="col" class="wp-cert-col-check"><span class="screen-reader-text">选择</span></th>
                        <th scope="col">标题</th>
                        <th scope="col">分组</th>
                        <th scope="col">状态</th>
                        <th scope="col">前端链接</th>
                        <th scope="col">更新时间</th>
                      </tr>
                    </thead>
                    <tbody id="cms-cert-list"></tbody>
                  </table>
                  <p class="wp-list-empty" id="cms-cert-empty" hidden data-site-text="emptyList">${escapeHtml(siteText('emptyList'))}</p>
                </div>

                <div class="wp-list-quick-bar" aria-label="证书快捷操作">
                  <button type="button" class="button button-sm button-primary cms-cert-new-trigger" data-site-text="newEntity">${escapeHtml(siteText('newEntity'))}</button>
                </div>
              </div>
            </section>

            <section class="wp-view-page" id="cms-view-edit" data-view="edit" data-site-aria="entityEdit">
              <div class="wp-editor-workspace" id="cms-editor-workspace">
                <div class="wp-edit-chrome">
                  <div class="wp-cert-toolbar" role="toolbar" data-site-aria="entityOps">
                    <div class="wp-cert-toolbar-row wp-cert-toolbar-row--main">
                      <div class="wp-cert-toolbar-group wp-cert-toolbar-group--primary">
                        <button type="button" class="button wp-back-list" id="cms-back-list">← 列表</button>
                        <span class="wp-toolbar-divider" aria-hidden="true"></span>
                        <label class="screen-reader-text" for="cms-cert-title" data-site-text="entityTitle">${escapeHtml(siteText('entityTitle'))}</label>
                        <input type="text" id="cms-cert-title" class="wp-cert-title-input" data-site-placeholder="entityTitle" placeholder="${escapeHtml(siteText('entityTitle'))}" />
                        <span id="cms-cert-status" class="wp-status-badge draft">草稿</span>
                      </div>
                      <div class="wp-cert-toolbar-group wp-cert-toolbar-group--table-search">
                        <label class="wp-table-search" title="在当前证书表格中搜索单元格内容">
                          <span class="screen-reader-text">搜索表格内容</span>
                          <input type="search" id="cms-table-search" class="wp-table-search-input" placeholder="搜索表格内容…" autocomplete="off" />
                        </label>
                        <span class="wp-table-search-count" id="cms-table-search-count" hidden aria-live="polite"></span>
                        <button type="button" class="button button-sm" id="cms-table-search-prev" disabled title="上一个匹配">↑</button>
                        <button type="button" class="button button-sm" id="cms-table-search-next" disabled title="下一个匹配">↓</button>
                      </div>
                      <div class="wp-cert-toolbar-group wp-cert-toolbar-group--actions">
                        <button type="button" class="button button-sm" id="cms-revisions">修订</button>
                        <button type="button" class="button button-sm button-primary" id="cms-save">保存</button>
                        <button type="button" class="button button-sm" id="cms-publish">发布</button>
                        <button type="button" class="button button-sm button-danger" id="cms-cert-delete">移到回收站</button>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="wp-editor-slot" id="cms-editor-slot" data-site-aria="entityContent">
                  <div class="wp-editor-preset-gate" id="cms-editor-preset-gate" hidden>
                    <div class="wp-editor-empty-inner">
                      <p class="wp-empty-icon" aria-hidden="true">📋</p>
                      <h2>请先选择默认布局</h2>
                      <p>新建${escapeHtml(E())}需先在上方工具栏关联布局模板，然后才能编辑表格与预览。</p>
                    </div>
                  </div>
                  <!-- .app 由 mountEditor 挂载到此 -->
                </div>
              </div>
            </section>

            <section class="wp-view-page" id="cms-view-site" data-view="site" aria-label="站点设置">
              <div class="wp-settings-host" id="cms-panel-site"></div>
            </section>

            <section class="wp-view-page" id="cms-view-templates" data-view="templates" aria-label="SVG 模板设置">
              <div class="wp-settings-host" id="cms-panel-templates"></div>
            </section>

            <section class="wp-view-page" id="cms-view-table-templates" data-view="table-templates" aria-label="表格模板设置">
              <div class="wp-settings-host" id="cms-panel-table-templates"></div>
            </section>

            <section class="wp-view-page" id="cms-view-layout-presets" data-view="layout-presets" aria-label="布局模板设置">
              <div class="wp-settings-host" id="cms-panel-layout-presets"></div>
            </section>

            <section class="wp-view-page" id="cms-view-fonts" data-view="fonts" aria-label="字体源设置">
              <div class="wp-settings-host" id="cms-panel-fonts"></div>
            </section>

            <section class="wp-view-page" id="cms-view-maintenance" data-view="maintenance" aria-label="数据维护">
              <div class="wp-settings-host" id="cms-panel-maintenance"></div>
            </section>

            <section class="wp-view-page" id="cms-view-access" data-view="access" aria-label="权限管理">
              <div class="wp-settings-host" id="cms-panel-access"></div>
            </section>

            <section class="wp-view-page" id="cms-view-analytics" data-view="analytics" aria-label="访客分析">
              <div class="wp-settings-host" id="cms-panel-analytics"></div>
            </section>
          </div>
        </div>
      </div>
    </div>

    <dialog id="cms-revisions-dialog" class="cms-dialog">
      <h3>修订记录</h3>
      <ul id="cms-revisions-list"></ul>
      <div class="cms-dialog-actions">
        <button type="button" class="btn" id="cms-revisions-close">关闭</button>
      </div>
    </dialog>

    <dialog id="cms-preset-switch-dialog" class="cms-dialog cms-preset-switch-dialog">
      <h3 class="cms-preset-switch-dialog__title">切换默认布局</h3>
      <div class="cms-preset-switch-dialog__alert" role="alert">
        <span class="cms-preset-switch-dialog__icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
            <path fill-rule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 00-.75.75v3.75a.75.75 0 001.5 0V9a.75.75 0 00-.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clip-rule="evenodd" />
          </svg>
        </span>
        <p class="cms-preset-switch-dialog__message">
          切换默认布局后，未单独指定布局的行将使用新默认模板。表格数据不会清空。
        </p>
      </div>
      <div class="cms-dialog-actions">
        <button type="button" class="btn btn-primary cms-preset-switch-dialog__confirm" id="cms-preset-switch-yes">是</button>
        <button type="button" class="btn" id="cms-preset-switch-no">否</button>
      </div>
    </dialog>

    <dialog id="cms-public-slug-dialog" class="cms-dialog cms-public-slug-dialog">
      <h3>自定义前端链接</h3>
      <p class="cms-public-slug-hint">只能修改链接末尾后缀；留空则使用证书编号。</p>
      <label class="cms-public-slug-field">
        <span id="cms-public-slug-prefix" class="cms-public-slug-prefix" aria-hidden="true"></span>
        <input type="text" id="cms-public-slug-input" class="cms-public-slug-input" maxlength="60" autocomplete="off" spellcheck="false" aria-label="链接后缀" />
      </label>
      <p class="cms-public-slug-error" id="cms-public-slug-error" hidden role="alert"></p>
      <div class="cms-dialog-actions">
        <button type="button" class="btn" id="cms-public-slug-clear">恢复编号</button>
        <button type="button" class="btn" id="cms-public-slug-cancel">取消</button>
        <button type="button" class="btn btn-primary" id="cms-public-slug-save">确定</button>
      </div>
    </dialog>
  `

  document.body.classList.add('has-wp-admin')

  const accountCenter = mountAccountCenter(root, {
    getUser: () => options.user,
    setUser: (user) => { Object.assign(options.user, user) },
    onStatus: (msg) => status(msg),
    formatRoleLabel: formatAdminRoleLabel,
  })

  const titleInput = root.querySelector('#cms-cert-title')
  const statusBadge = root.querySelector('#cms-cert-status')
  const presetSelect = document.querySelector('#cms-preset-select')
  const smartLayoutColSelect = document.querySelector('#cms-smart-layout-col')
  const smartLayoutApplyBtn = document.querySelector('#cms-smart-layout-apply')
  const tableSearchInput = root.querySelector('#cms-table-search')
  const tableSearchCount = root.querySelector('#cms-table-search-count')
  const tableSearchPrev = root.querySelector('#cms-table-search-prev')
  const tableSearchNext = root.querySelector('#cms-table-search-next')
  const certListEl = root.querySelector('#cms-cert-list')
  const certEmpty = root.querySelector('#cms-cert-empty')
  const certSearchInput = root.querySelector('#cms-cert-search')
  const viewPages = {
    overview: root.querySelector('#cms-view-overview'),
    list: root.querySelector('#cms-view-list'),
    edit: root.querySelector('#cms-view-edit'),
    site: root.querySelector('#cms-view-site'),
    templates: root.querySelector('#cms-view-templates'),
    'table-templates': root.querySelector('#cms-view-table-templates'),
    'layout-presets': root.querySelector('#cms-view-layout-presets'),
    fonts: root.querySelector('#cms-view-fonts'),
    maintenance: root.querySelector('#cms-view-maintenance'),
    access: root.querySelector('#cms-view-access'),
    analytics: root.querySelector('#cms-view-analytics'),
  }
  const revisionsDialog = root.querySelector('#cms-revisions-dialog')
  const presetSwitchDialog = root.querySelector('#cms-preset-switch-dialog')
  const presetSwitchYesBtn = root.querySelector('#cms-preset-switch-yes')
  const presetSwitchNoBtn = root.querySelector('#cms-preset-switch-no')
  const publicSlugDialog = root.querySelector('#cms-public-slug-dialog')
  const publicSlugPrefixEl = root.querySelector('#cms-public-slug-prefix')
  const publicSlugInput = root.querySelector('#cms-public-slug-input')
  const publicSlugErrorEl = root.querySelector('#cms-public-slug-error')
  const revisionsList = root.querySelector('#cms-revisions-list')
  const editorWorkspace = root.querySelector('#cms-editor-workspace')
  const editorSlot = root.querySelector('#cms-editor-slot')
  const editorPresetGate = root.querySelector('#cms-editor-preset-gate')
  const panelTemplates = root.querySelector('#cms-panel-templates')
  const panelTableTemplates = root.querySelector('#cms-panel-table-templates')
  const panelLayoutPresets = root.querySelector('#cms-panel-layout-presets')
  const panelFonts = root.querySelector('#cms-panel-fonts')
  const panelSite = root.querySelector('#cms-panel-site')
  const panelOverview = root.querySelector('#cms-panel-overview')
  const panelMaintenance = root.querySelector('#cms-panel-maintenance')
  const panelAccess = root.querySelector('#cms-panel-access')
  const panelAnalytics = root.querySelector('#cms-panel-analytics')

  let analyticsPanel = null

  async function openPublicSlugDialog() {
    if (!publicSlugDialog || !publicSlugInput || !publicSlugPrefixEl) return
    const cfg = await resolveSiteConfigForCertGroup(currentCertGroupId)
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const suffix = effectivePublicSlugSuffix()
    const parts = splitPublicCertUrlSuffix(cfg, suffix, origin)
    publicSlugPrefixEl.textContent = parts.prefix
    if (currentPublicSlug) {
      publicSlugInput.value = currentPublicSlug
    } else if (currentCertId) {
      publicSlugInput.value = ''
    } else {
      publicSlugInput.value = suggestPublicSlugFromTitle(titleInput?.value || '')
    }
    publicSlugInput.placeholder = currentCertId && !currentPublicSlug
      ? String(currentCertId)
      : (suggestPublicSlugFromTitle(titleInput?.value || '') || '留空则使用证书编号')
    if (publicSlugErrorEl) {
      publicSlugErrorEl.hidden = true
      publicSlugErrorEl.textContent = ''
    }
    publicSlugDialog.showModal()
    publicSlugInput.focus()
    publicSlugInput.select()
  }

  async function applyPublicSlugFromDialog(rawValue, clearToDefault = false) {
    if (publicSlugErrorEl) {
      publicSlugErrorEl.hidden = true
      publicSlugErrorEl.textContent = ''
    }
    const groupId = resolveEffectiveCertGroupId()
    if (clearToDefault) {
      currentPublicSlug = null
      publicSlugTouched = true
      markDirty()
      void syncPublicCertLink()
      return true
    }
    const trimmed = String(rawValue ?? '').trim()
    if (currentCertId && trimmed === '') {
      currentPublicSlug = null
      publicSlugTouched = true
      markDirty()
      void syncPublicCertLink()
      return true
    }
    if (!currentCertId && trimmed === '') {
      currentPublicSlug = null
      publicSlugTouched = false
      void syncPublicCertLink()
      return true
    }
    try {
      const check = await api.checkPublicCertSlug(trimmed, {
        groupId,
        excludeId: currentCertId,
      })
      if (!check.available) {
        if (publicSlugErrorEl) {
          publicSlugErrorEl.hidden = false
          publicSlugErrorEl.textContent = check.error || '该链接后缀已被使用'
        }
        return false
      }
      currentPublicSlug = check.slug
      publicSlugTouched = true
      markDirty()
      void syncPublicCertLink()
      return true
    } catch (err) {
      if (publicSlugErrorEl) {
        publicSlugErrorEl.hidden = false
        publicSlugErrorEl.textContent = err.message || '校验失败'
      }
      return false
    }
  }

  function syncViewPanels() {
    for (const [name, el] of Object.entries(viewPages)) {
      el?.classList.toggle('is-active', name === currentView)
    }
  }

  function setEditingMode(on) {
    if (currentView !== 'edit') return
    editorWorkspace.hidden = !on
  }

  function isNewCertAwaitingPreset() {
    return isDraftNewCert && !currentCertId && !currentPresetId
  }

  function syncNewCertPresetGate() {
    const gated = isNewCertAwaitingPreset()
    document.body.classList.toggle('cert-new-awaiting-preset', gated)
    if (editorPresetGate) editorPresetGate.hidden = !gated
    editorSlot?.classList.toggle('is-preset-gated', gated)
    if (presetSelect) {
      presetSelect.classList.toggle('is-required', gated)
      if (gated) presetSelect.setAttribute('aria-required', 'true')
      else presetSelect.removeAttribute('aria-required')
    }
    if (titleInput) titleInput.disabled = gated
    if (tableSearchInput) tableSearchInput.disabled = gated
    if (tableSearchPrev) tableSearchPrev.disabled = gated
    if (tableSearchNext) tableSearchNext.disabled = gated
    root.querySelector('#cms-save')?.toggleAttribute('disabled', gated)
    root.querySelector('#cms-publish')?.toggleAttribute('disabled', gated)
    root.querySelector('#cms-revisions')?.toggleAttribute('disabled', gated)
    root.querySelector('#cms-cert-delete')?.toggleAttribute('disabled', gated || !currentCertId)
  }

  function requirePresetForNewCert(actionLabel = '此操作') {
    if (!isNewCertAwaitingPreset()) return true
    status(`请先选择默认布局，再${actionLabel}`)
    presetSelect?.focus()
    return false
  }

  async function ensureSettingsPanel(view) {
    if (view === 'templates' && !templatesPanel) {
      templatesPanel = mountTemplatesPanel(panelTemplates, {
        user: options.user,
        accessGroups,
        onChange: async () => {
          await refreshTemplates()
        },
      })
      await templatesPanel.init()
    }
    if (view === 'table-templates' && !tableTemplatesPanel) {
      tableTemplatesPanel = mountTableTemplatesPanel(panelTableTemplates, {
        user: options.user,
        accessGroups,
        getCurrentColumns: () => options.getEditorState().columnOrder || [],
        getCurrentTableData: () => options.getEditorState().tableData || [],
        onChange: async () => {
          await refreshTableTemplates()
        },
      })
      await tableTemplatesPanel.init()
    }
    if (view === 'layout-presets' && !layoutPresetsPanel) {
      layoutPresetsPanel = mountLayoutPresetsPanel(panelLayoutPresets, {
        user: options.user,
        accessGroups,
        onChange: async () => {
          await refreshPresets()
          invalidateGroupCache()
          accessGroups = await loadAccessibleGroups(true)
          if (currentView === 'list') renderCertTable()
        },
      })
      await layoutPresetsPanel.init()
    }
    if (view === 'fonts' && !fontsPanel) {
      fontsPanel = mountFontsPanel(panelFonts)
      await fontsPanel.init()
    }
    if (view === 'site' && !siteSettingsPanel) {
      siteSettingsPanel = mountSiteSettingsPanel(panelSite, {
        user: options.user,
        onSaved: (cfg) => {
          invalidateAdminLoginHrefCache()
          invalidatePublicLoginHrefCache()
          if (cfg?.group_id != null) invalidateGroupSiteConfigCache(cfg.group_id)
          applySiteBranding(cfg)
          void syncPublicCertLink()
          if (currentView === 'list') void refreshCertList()
        },
      })
      await siteSettingsPanel.init()
    }
    if (view === 'access' && !accessManagePanel) {
      accessManagePanel = mountAccessManagePanel(panelAccess, {
        editor: options.user,
        onGroupsChanged: async () => {
          invalidateGroupCache()
          accessGroups = await loadAccessibleGroups(true)
          await refreshCertList()
          await refreshPresets()
        },
      })
      await accessManagePanel.init()
    }
    if (view === 'overview') {
      if (!overviewPanel) {
        overviewPanel = mountOverviewPanel(panelOverview, {
          user: options.user,
          onOpenMaintenance: () => {
            showView('maintenance').catch((err) => status(err.message || '切换失败'))
          },
        })
        await overviewPanel.init()
      } else {
        await overviewPanel.refresh?.()
      }
    }
    if (view === 'maintenance') {
      if (!maintenancePanel) {
        maintenancePanel = mountMaintenancePanel(panelMaintenance, { user: options.user })
        await maintenancePanel.init()
      } else {
        maintenancePanel.switchTab('backup')
      }
    }
    if (view === 'analytics') {
      if (!analyticsPanel) {
        const { mountVisitorAnalyticsPanel } = await import('./visitorAnalytics.js')
        analyticsPanel = { mount: mountVisitorAnalyticsPanel }
      }
      await analyticsPanel.mount(panelAnalytics)
    }
  }

  /** 需在 wp-settings-host 中懒加载的面板视图 */
  const SETTINGS_VIEWS = new Set([
    'overview',
    'templates',
    'table-templates',
    'layout-presets',
    'fonts',
    'site',
    'access',
    'maintenance',
    'analytics',
  ])

  function resolveViewFromLocation() {
    const locParams = new URLSearchParams(window.location.search)
    if (locParams.get('cert')) return 'edit'
    const raw = locParams.get('view')
    if (raw === 'block-templates') return 'layout-presets'
    if (raw) return raw
    return 'list'
  }

  function buildViewUrl(view) {
    const url = new URL(window.location.href)
    if (view === 'list') {
      url.searchParams.delete('view')
      url.searchParams.delete('cert')
    } else if (view === 'edit' && currentCertId) {
      url.searchParams.delete('view')
      url.searchParams.set('cert', String(currentCertId))
    } else if (view === 'edit' && isDraftNewCert) {
      url.searchParams.set('view', 'edit')
      url.searchParams.delete('cert')
    } else {
      url.searchParams.set('view', view)
      if (view !== 'edit') url.searchParams.delete('cert')
    }
    return url
  }

  function syncViewHistory(view, historyMode) {
    if (historyMode === 'none') return
    const url = buildViewUrl(view)
    const state = { cmsView: view, cmsCertId: currentCertId ?? null }
    if (historyMode === 'replace') {
      window.history.replaceState(state, '', url)
    } else {
      window.history.pushState(state, '', url)
    }
  }

  async function showView(view, { skipDirtyCheck = false, history: historyMode = 'push' } = {}) {
    if (view === 'block-templates') view = 'layout-presets'
    const allowedViews = ['overview', 'list', 'edit', 'site', 'templates', 'table-templates', 'layout-presets', 'fonts', 'maintenance', 'access', 'analytics']
    if (!allowedViews.includes(view)) {
      view = 'overview'
    }
    if (view !== 'list' && view !== 'edit' && view !== 'overview' && !canModule(view)) {
      status('无权访问该功能模块')
      view = 'overview'
    }

    if (!skipDirtyCheck && currentView === 'edit' && view !== 'edit' && dirty) {
      if (!window.confirm('当前有未保存修改，离开将丢失，继续？')) {
        if (historyMode === 'none') history.forward()
        return
      }
      dirty = false
    }

    if (currentView === 'edit' && view !== 'edit') {
      clearTimeout(saveTimer)
      if (isDraftNewCert && !currentCertId) {
        isDraftNewCert = false
      }
    }

    if (view === 'edit') {
      const certParam = new URLSearchParams(window.location.search).get('cert')
      if (certParam && !isDraftNewCert) {
        const id = Number(certParam)
        if (id !== currentCertId) {
          if (!skipDirtyCheck && currentView === 'edit' && dirty) {
            if (!window.confirm('当前有未保存修改，切换将丢失，继续？')) {
              if (historyMode === 'none') history.forward()
              return
            }
            dirty = false
          }
          await loadCertificate(id)
        }
      } else if (!currentCertId && !isDraftNewCert) {
        view = 'list'
      }
    }

    currentView = view
    syncViewPanels()
    if (view === 'edit') {
      refreshSmartLayoutColumnOptions()
      syncNewCertPresetGate()
    } else {
      syncSmartLayoutApplyButton()
    }

    const hadTemplatesPanel = !!templatesPanel
    const hadTableTemplatesPanel = !!tableTemplatesPanel
    const hadLayoutPresetsPanel = !!layoutPresetsPanel
    if (SETTINGS_VIEWS.has(view)) {
      await ensureSettingsPanel(view)
    }

    if (view === 'templates') {
      if (hadTemplatesPanel) await templatesPanel.repaint?.()
    } else {
      templatesPanel?.removeLegacyInlineSvgs?.()
    }

    if (view === 'table-templates') {
      if (hadTableTemplatesPanel) await tableTemplatesPanel.repaint?.()
    }

    if (view === 'layout-presets') {
      if (hadLayoutPresetsPanel) await layoutPresetsPanel.repaint?.()
    } else {
      layoutPresetsPanel?.suspend?.()
    }

    root.querySelectorAll('.wp-nav-link[data-view]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === view)
    })

    syncViewHistory(view, historyMode)
    options.onTableRefreshNeeded?.()
    if (view === 'edit') {
      void syncPublicCertLink()
    } else {
      const wrap = document.getElementById('cms-public-cert-link-wrap')
      if (wrap) wrap.hidden = true
    }
  }

  async function goToList() {
    await showView('list')
    renderCertTable()
  }

  /** 将页面上的 .app 移入证书编辑区（WordPress「写文章」式布局） */
  function mountEditor(appEl) {
    if (!appEl || !editorSlot || appEl.parentElement === editorSlot) return
    appEl.classList.add('wp-editor-app')
    editorSlot.appendChild(appEl)
    document.body.classList.add('cert-layout-readonly')
    const titleEl = document.getElementById('preview-panel-title')
    if (titleEl) titleEl.textContent = siteText('entityPreview')
    window.__CAT_EDITOR_SPLIT__?.restore?.()
    window.__CAT_PREVIEW_FLOAT__?.applyState?.()
    window.__CAT_SET_CERT_PREVIEW_PAN__?.()
    const tableWrap = appEl.querySelector('#table-wrap')
    if (tableWrap) wireLayoutPresetControls(tableWrap)
    const mainEl = appEl.querySelector('.main')
    if (editorPresetGate && mainEl && editorPresetGate.parentElement !== mainEl) {
      mainEl.appendChild(editorPresetGate)
    }
    syncNewCertPresetGate()
    void syncPublicCertLink()
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  }

  function updateTableSearchUi(state) {
    const total = state?.total ?? 0
    const current = state?.current ?? 0
    if (tableSearchCount) {
      if (total > 0) {
        tableSearchCount.hidden = false
        tableSearchCount.textContent = `${current}/${total}`
      } else if (tableSearchInput?.value.trim()) {
        tableSearchCount.hidden = false
        tableSearchCount.textContent = '0/0'
      } else {
        tableSearchCount.hidden = true
        tableSearchCount.textContent = ''
      }
    }
    const has = total > 0
    if (tableSearchPrev) tableSearchPrev.disabled = !has
    if (tableSearchNext) tableSearchNext.disabled = !has
  }

  function runTableSearch(query) {
    const api = window.__CAT_SPREADSHEET__
    if (!api?.setSearchQuery) {
      updateTableSearchUi({ total: 0, current: 0 })
      return
    }
    updateTableSearchUi(api.setSearchQuery(query))
  }

  tableSearchInput?.addEventListener('input', () => {
    runTableSearch(tableSearchInput.value)
  })
  tableSearchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const api = window.__CAT_SPREADSHEET__
      if (e.shiftKey) updateTableSearchUi(api?.gotoPrevSearchMatch?.())
      else updateTableSearchUi(api?.gotoNextSearchMatch?.())
      tableSearchInput?.focus()
    }
    if (e.key === 'Escape') {
      tableSearchInput.value = ''
      runTableSearch('')
    }
  })
  tableSearchPrev?.addEventListener('click', () => {
    updateTableSearchUi(window.__CAT_SPREADSHEET__?.gotoPrevSearchMatch?.())
    tableSearchInput?.focus()
  })
  tableSearchNext?.addEventListener('click', () => {
    updateTableSearchUi(window.__CAT_SPREADSHEET__?.gotoNextSearchMatch?.())
    tableSearchInput?.focus()
  })

  function status(msg) {
    options.onStatus?.(msg)
  }

  function markDirty() {
    dirty = true
    scheduleAutosave()
  }

  function editorPayload() {
    const s = options.getEditorState()
    const rowPresetIds = options.getRowPresetIds?.() ?? s.rowPresetIds ?? []
    const payload = {
      title: titleInput.value.trim() || s.title || untitledName(),
      column_order: s.columnOrder || [],
      layout_overrides: currentPresetId ? {} : s.layoutOverrides,
      font_scale: s.fontScale,
      show_layout_boxes: s.showLayoutBoxes,
      template_id: currentPresetSvgId ?? s.templateId ?? null,
      preset_id: currentPresetId ?? null,
      table_template_id: currentPresetTableTemplateId ?? null,
      rows: (s.tableData || []).map((rowData, i) => ({
        row_data: rowData,
        preset_id: rowPresetIds[i] ?? null,
      })),
      preview_ui: s.previewUi || {},
      revision_note: '自动保存',
    }
    const gid = resolveEffectiveCertGroupId()
    if (gid) payload.group_id = gid
    if (publicSlugTouched) {
      payload.public_slug = currentPublicSlug ?? null
    }
    return payload
  }

  function updateStatusBadge() {
    statusBadge.textContent = currentStatus === 'published' ? '已发布' : '草稿'
    statusBadge.className = `wp-status-badge ${currentStatus}`
    root.querySelector('#cms-publish').textContent = currentStatus === 'published' ? '撤回发布' : '发布'
    root.querySelector('#cms-publish').classList.toggle('button-primary', currentStatus !== 'published')
    void syncPublicCertLink()
  }

  function isCertTrashed(c) {
    const v = c?.deleted_at
    return v != null && String(v).trim() !== ''
  }

  /** 列表批量操作计数（每项 = 一个可编辑的证书列表/批次） */
  function certBatchCountLabel(n) {
    return `${n} 项`
  }

  function certSelectionPreview(titles) {
    if (titles.length <= 3) {
      return titles.map((t) => `「${t}」`).join('、')
    }
    return `「${titles[0]}」等 ${certBatchCountLabel(titles.length)}`
  }

  function filteredCertificates() {
    let list = certificates
    if (certFilter === 'trash') {
      list = list.filter((c) => isCertTrashed(c))
    } else {
      list = list.filter((c) => !isCertTrashed(c))
      if (certFilter === 'draft') list = list.filter((c) => c.status === 'draft')
      if (certFilter === 'published') list = list.filter((c) => c.status === 'published')
    }
    if (certSearch.trim()) {
      list = list.filter((c) => searchTextIncludes(
        c.search_text || `${c.title || ''} ${c.group_name || ''}`,
        certSearch,
      ))
    }
    return list
  }

  function certGroupMeta(c, mode) {
    if (mode === 'status') {
      if (isCertTrashed(c)) {
        const from = c.trashed_from_status === 'published' ? '已发布' : '草稿'
        return { key: `trash-${from}`, label: `原为${from}` }
      }
      return { key: c.status, label: c.status === 'published' ? '已发布' : '草稿' }
    }
    if (mode === 'month') {
      const d = isCertTrashed(c) && c.deleted_at
        ? new Date(c.deleted_at)
        : (c.updated_at ? new Date(c.updated_at) : null)
      if (!d || Number.isNaN(d.getTime())) return { key: 'unknown', label: '未知日期' }
      const y = d.getFullYear()
      const m = d.getMonth() + 1
      return { key: `${y}-${String(m).padStart(2, '0')}`, label: `${y}年${m}月` }
    }
    if (mode === 'group') {
      const label = (c.group_name || '').trim() || '未分组'
      return { key: label, label }
    }
    return { key: '', label: '' }
  }

  function groupCertificates(list, mode) {
    if (mode === 'none') return [{ key: '', label: '', items: list }]
    const map = new Map()
    for (const c of list) {
      const meta = certGroupMeta(c, mode)
      if (!map.has(meta.key)) map.set(meta.key, { key: meta.key, label: meta.label, items: [] })
      map.get(meta.key).items.push(c)
    }
    const groups = [...map.values()]
    if (mode === 'month') {
      groups.sort((a, b) => b.key.localeCompare(a.key, 'zh-CN'))
    } else if (mode === 'status') {
      const order = { draft: 0, published: 1 }
      groups.sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9))
    } else {
      groups.sort((a, b) => {
        if (a.label === '未分组') return 1
        if (b.label === '未分组') return -1
        return a.label.localeCompare(b.label, 'zh-CN')
      })
    }
    return groups
  }

  const CERT_TABLE_COLS = 6

  async function cloneCertificateFromServer(id, titleOverride = null) {
    const { certificate } = await api.getCertificate(id)
    const title = String(titleOverride || `${certificate.title} (副本)`).trim() || `${untitledName()} (副本)`
    const { id: newId } = await api.createCertificate({
      title,
      preset_id: certificate.preset_id,
      template_id: certificate.template_id,
      table_template_id: certificate.table_template_id,
      column_order: certificate.column_order,
      layout_overrides: certificate.layout_overrides,
      font_scale: certificate.font_scale,
      show_layout_boxes: certificate.show_layout_boxes,
      group_name: certificate.group_name,
      preview_ui: certificate.preview_ui || {},
      rows: (certificate.rows || []).map((r) => ({
        row_data: r.row_data ?? r,
        preset_id: r.preset_id ?? null,
      })),
    })
    return newId
  }

  function renderCertTableRow(c) {
    const active = c.id === currentCertId ? ' is-active' : ''
    const selected = certSelectedIds.has(c.id) ? ' is-selected' : ''
    const checked = certSelectedIds.has(c.id) ? ' checked' : ''
    const inTrash = isCertTrashed(c)
    const st = inTrash
      ? 'trashed'
      : (c.status === 'published' ? 'published' : 'draft')
    const stLabel = inTrash
      ? `原为${c.trashed_from_status === 'published' ? '已发布' : '草稿'}`
      : (st === 'published' ? '已发布' : '草稿')
    const title = escapeHtml(c.title || '未命名')
    const groupValue = escapeHtml(c.group_name || '')
    const accessBadge = c.group_id != null && accessGroups.length
      ? groupBadgeHtml(c.group_id, accessGroups)
      : ''
    const dateIso = inTrash ? (c.deleted_at || c.updated_at) : c.updated_at
    const groupCell = inTrash
      ? `<td class="wp-cert-cell-group"><span class="access-muted">${groupValue || '—'}</span></td>`
      : `<td class="wp-cert-cell-group">
        <input type="text" class="wp-cert-group-input" data-id="${c.id}" value="${groupValue}" placeholder="未分组" aria-label="分组 ${title}" />
      </td>`
    const linkCell = (() => {
      if (inTrash || st !== 'published') {
        return '<td class="wp-cert-cell-link"><span class="access-muted">—</span></td>'
      }
      const url = publicCertUrlForRow(c)
      if (!url) {
        return '<td class="wp-cert-cell-link"><span class="access-muted" title="加载链接配置中">…</span></td>'
      }
      const safeUrl = escapeHtml(url)
      const label = escapeHtml(formatPublicCertLinkLabel(url))
      return `<td class="wp-cert-cell-link">
        <a class="wp-cert-public-link" href="${safeUrl}" target="_blank" rel="noopener" title="${safeUrl}">${label}</a>
        <button type="button" class="button-link button-sm wp-cert-public-copy" data-url="${safeUrl}">复制</button>
      </td>`
    })()
    return `<tr class="wp-cert-row${active}${selected}" data-id="${c.id}">
      <td class="wp-cert-col-check">
        <input type="checkbox" class="wp-cert-row-check" data-id="${c.id}"${checked} aria-label="选择 ${title}" />
      </td>
      <td class="wp-cert-cell-title">${title}${accessBadge}</td>
      ${groupCell}
      <td><span class="wp-status-badge sm ${st}">${stLabel}</span></td>
      ${linkCell}
      <td class="wp-cert-cell-date">${formatTime(dateIso)}</td>
    </tr>`
  }

  function updateCertBatchBar() {
    const list = filteredCertificates()
    const visibleIds = list.map((c) => c.id)
    const selectedVisible = visibleIds.filter((id) => certSelectedIds.has(id))
    const count = selectedVisible.length
    const inTrash = certFilter === 'trash'
    const batchBar = root.querySelector('#cms-cert-batch-bar')
    const selectAllEl = root.querySelector('#cms-cert-select-all')
    const countEl = root.querySelector('#cms-cert-selection-count')
    const batchEditBtn = root.querySelector('#cms-cert-batch-edit')
    const batchDeleteBtn = root.querySelector('#cms-cert-batch-delete')
    const batchCopyBtn = root.querySelector('#cms-cert-batch-copy')
    const batchGroupBtn = root.querySelector('#cms-cert-batch-group')
    const batchRestoreBtn = root.querySelector('#cms-cert-batch-restore')
    const batchPurgeBtn = root.querySelector('#cms-cert-batch-purge')
    const quickBar = root.querySelector('.wp-list-quick-bar')

    batchBar.hidden = list.length === 0
    countEl.textContent = count ? `已选 ${count} 项` : ''
    batchEditBtn.disabled = count !== 1
    batchEditBtn.hidden = inTrash
    batchDeleteBtn.disabled = count === 0
    batchDeleteBtn.hidden = inTrash
    batchCopyBtn.disabled = count === 0
    batchCopyBtn.hidden = inTrash
    batchGroupBtn.disabled = count === 0
    batchGroupBtn.hidden = inTrash
    if (batchRestoreBtn) {
      batchRestoreBtn.hidden = !inTrash
      batchRestoreBtn.disabled = count === 0
    }
    if (batchPurgeBtn) {
      batchPurgeBtn.hidden = !inTrash
      batchPurgeBtn.disabled = count === 0
    }
    if (quickBar) quickBar.hidden = inTrash
    setDataTransferExportDisabled(root, 'cms-cert', count === 0 || inTrash)

    if (selectAllEl) {
      selectAllEl.indeterminate = count > 0 && count < visibleIds.length
      selectAllEl.checked = visibleIds.length > 0 && count === visibleIds.length
    }
  }

  function syncCertSelectionAfterRefresh() {
    const ids = new Set(certificates.map((c) => c.id))
    for (const id of certSelectedIds) {
      if (!ids.has(id)) certSelectedIds.delete(id)
    }
    updateCertBatchBar()
  }

  function confirmTrashCertificates(ids) {
    const uniqueIds = [...new Set(ids.filter((id) => id > 0))]
    if (!uniqueIds.length) return null
    const titles = uniqueIds.map((id) => certificates.find((c) => c.id === id)?.title || `#${id}`)
    const preview = certSelectionPreview(titles)
    const warnCurrent = uniqueIds.includes(currentCertId) && dirty ? `当前编辑的内容有未保存修改，` : ''
    if (!window.confirm(`${warnCurrent}确定将 ${preview} 移入回收站？`)) return null
    return uniqueIds
  }

  function confirmPurgeCertificates(ids) {
    const uniqueIds = [...new Set(ids.filter((id) => id > 0))]
    if (!uniqueIds.length) return null
    const titles = uniqueIds.map((id) => certificates.find((c) => c.id === id)?.title || `#${id}`)
    const preview = certSelectionPreview(titles)
    if (!window.confirm(`永久删除 ${preview}？此操作无法恢复。`)) return null
    return uniqueIds
  }

  async function trashCertificates(ids) {
    const uniqueIds = confirmTrashCertificates(ids)
    if (!uniqueIds) return
    try {
      await api.batchDeleteCertificates(uniqueIds)
      for (const id of uniqueIds) certSelectedIds.delete(id)
      if (uniqueIds.includes(currentCertId)) {
        currentCertId = null
        isDraftNewCert = false
        dirty = false
      }
      await refreshCertList()
      if (currentView === 'edit' && !currentCertId) {
        await goToList()
      }
      status(`已将 ${certBatchCountLabel(uniqueIds.length)}移入回收站`)
    } catch (err) {
      status(err.message || '移入回收站失败')
    }
  }

  async function restoreCertificates(ids) {
    const uniqueIds = [...new Set(ids.filter((id) => id > 0))]
    if (!uniqueIds.length) return
    try {
      await api.batchRestoreCertificates(uniqueIds)
      for (const id of uniqueIds) certSelectedIds.delete(id)
      await refreshCertList()
      status(`已恢复 ${certBatchCountLabel(uniqueIds.length)}`)
    } catch (err) {
      status(err.message || '恢复失败')
    }
  }

  async function purgeCertificates(ids) {
    const uniqueIds = confirmPurgeCertificates(ids)
    if (!uniqueIds) return
    const trashedIds = uniqueIds.filter((id) => {
      const c = certificates.find((x) => Number(x.id) === Number(id))
      return c && isCertTrashed(c)
    })
    if (!trashedIds.length) {
      status('所选项目不在回收站中，请打开「回收站」筛选后再试')
      return
    }
    if (trashedIds.length < uniqueIds.length) {
      if (!window.confirm(`仅 ${trashedIds.length} 项在回收站中，确定永久删除？`)) return
    }
    try {
      await api.batchPurgeCertificates(trashedIds)
      for (const id of trashedIds) certSelectedIds.delete(id)
      if (trashedIds.includes(currentCertId)) {
        currentCertId = null
        isDraftNewCert = false
        dirty = false
      }
      await refreshCertList()
      if (currentView === 'edit' && !currentCertId) {
        await goToList()
      }
      status(`已永久删除 ${certBatchCountLabel(trashedIds.length)}`)
    } catch (err) {
      status(err.message || '永久删除失败')
    }
  }

  async function duplicateCertificates(ids) {
    const uniqueIds = [...new Set(ids.filter((id) => id > 0))]
    if (!uniqueIds.length) return
    try {
      const newIds = []
      for (const id of uniqueIds) {
        const newId = await cloneCertificateFromServer(id)
        newIds.push(newId)
      }
      await refreshCertList(newIds[0])
      status(`已复制 ${certBatchCountLabel(newIds.length)}`)
      return newIds
    } catch (err) {
      status(err.message || '复制失败')
      return null
    }
  }

  async function updateCertificateGroup(id, groupName) {
    const normalized = String(groupName || '').trim() || null
    const existing = certificates.find((c) => c.id === id)
    const prev = (existing?.group_name || '').trim() || null
    if (prev === normalized) return
    try {
      await api.updateCertificate(id, { group_name: normalized || '', revision_note: '更新分组' })
      if (existing) existing.group_name = normalized
      renderCertTable()
      status('分组已更新')
    } catch (err) {
      status(err.message || '更新分组失败')
      renderCertTable()
    }
  }

  async function assignGroupToCertificates(ids, groupName) {
    const uniqueIds = [...new Set(ids.filter((id) => id > 0))]
    if (!uniqueIds.length) return
    const normalized = String(groupName || '').trim() || null
    try {
      await Promise.all(uniqueIds.map((id) =>
        api.updateCertificate(id, { group_name: normalized || '', revision_note: '批量设置分组' }),
      ))
      for (const id of uniqueIds) {
        const item = certificates.find((c) => c.id === id)
        if (item) item.group_name = normalized
      }
      renderCertTable()
      status(`已为 ${certBatchCountLabel(uniqueIds.length)}设置分组`)
    } catch (err) {
      status(err.message || '设置分组失败')
    }
  }

  function renderCertTable() {
    const list = filteredCertificates()
    certEmpty.hidden = list.length > 0
    certEmpty.textContent = certFilter === 'trash' ? '回收站为空' : siteText('emptyList')
    if (list.length === 0) {
      certListEl.innerHTML = ''
      updateCertBatchBar()
      return
    }
    const groups = groupCertificates(list, certGroupBy)
    certListEl.innerHTML = groups.map((g) => {
      const header = certGroupBy === 'none'
        ? ''
        : `<tr class="wp-cert-group-row"><td colspan="${CERT_TABLE_COLS}"><span class="wp-cert-group-label">${escapeHtml(g.label)}</span><span class="wp-cert-group-count">${g.items.length} 项</span></td></tr>`
      return header + g.items.map((c) => renderCertTableRow(c)).join('')
    }).join('')
    updateCertBatchBar()
  }

  async function refreshCertList(selectId = currentCertId) {
    const res = await api.listCertificates(certFilter)
    certificates = res.certificates || []
    syncCertSelectionAfterRefresh()
    await preloadPublishedCertLinkConfigs(certificates)
    renderCertTable()
    if (selectId) highlightCertRow(selectId)
    void refreshCertCounts()
    void syncPublicCertLink()
  }

  function highlightCertRow(id) {
    certListEl.querySelectorAll('.wp-cert-row').forEach((row) => {
      row.classList.toggle('is-active', Number(row.dataset.id) === id)
    })
  }

  async function selectCertificate(id) {
    if (certFilter === 'trash') {
      status('回收站中的证书请先恢复后再编辑')
      return
    }
    if (id === currentCertId && currentView === 'edit') return
    if (dirty && currentView === 'edit' && id !== currentCertId) {
      if (!window.confirm('当前有未保存修改，切换将丢失，继续？')) return
    }
    await loadCertificate(id)
    await showView('edit', { skipDirtyCheck: true })
    highlightCertRow(id)
  }

  async function refreshPresets() {
    const res = await api.listPresets()
    presets = res.presets || []
    const groupName = (gid) => accessGroups.find((g) => g.id === Number(gid))?.name || ''
    const optionsHtml = '<option value="">— 未关联布局模板 —</option>'
      + presets.map((p) => {
        const gLabel = p.group_id != null ? ` · ${groupName(p.group_id)}` : ''
        return `<option value="${p.id}">${escapeHtml(p.name)}${p.is_default ? ' ★' : ''}${escapeHtml(gLabel)}</option>`
      }).join('')
    presetSelect.innerHTML = optionsHtml
    syncPresetSelect(currentPresetId)
    refreshSmartLayoutColumnOptions()
    options.onTableRefreshNeeded?.()
  }

  const CROSS_GROUP_PRESET_MSG = '不同访问组的布局模板不能在同一张证书表格中使用，请分开创建证书。'

  function collectPresetGroupIds({ defaultPresetId = currentPresetId, rowPresetIds = options.getRowPresetIds?.() ?? [] } = {}) {
    const groupIds = new Set()
    const add = (pid) => {
      if (!pid) return
      const p = presets.find((x) => Number(x.id) === Number(pid))
      if (p?.group_id != null) groupIds.add(Number(p.group_id))
    }
    add(defaultPresetId)
    for (const rid of rowPresetIds) add(rid)
    return groupIds
  }

  function crossGroupPresetError(override = {}) {
    if (collectPresetGroupIds(override).size > 1) return CROSS_GROUP_PRESET_MSG
    return null
  }

  function isPresetCompatibleWithCertTable(preset) {
    const presetTableId = preset.table_template_id != null ? Number(preset.table_template_id) : null
    if (!presetTableId) return true
    if (!currentPresetTableTemplateId) return true
    return presetTableId === Number(currentPresetTableTemplateId)
  }

  function syncSmartLayoutApplyButton() {
    if (!smartLayoutApplyBtn) return
    const hasCol = Boolean(smartLayoutColSelect?.value)
    smartLayoutApplyBtn.disabled = !hasCol || !presets.length || currentView !== 'edit'
  }

  function refreshSmartLayoutColumnOptions() {
    if (!smartLayoutColSelect) return
    const cols = options.getEditorState?.().columnOrder || []
    const prev = smartLayoutColSelect.value
    const saved = currentCertId
      ? localStorage.getItem(`cat.smartLayoutCol.${currentCertId}`)
      : null
    let html = '<option value="">列…</option>'
    for (const col of cols) {
      html += `<option value="${escapeAttr(col)}">${escapeHtml(col)}</option>`
    }
    smartLayoutColSelect.innerHTML = html
    const pick = (saved && cols.includes(saved))
      ? saved
      : ((prev && cols.includes(prev)) ? prev : '')
    smartLayoutColSelect.value = pick
    syncSmartLayoutApplyButton()
  }

  async function applySmartLayoutPresets() {
    const columnId = smartLayoutColSelect?.value
    if (!columnId) {
      status('请先选择用于匹配的列')
      return
    }
    const s = options.getEditorState()
    const rows = s.tableData || []
    if (!rows.length) {
      status('表格无数据')
      return
    }
    const compatible = presets.filter((p) => isPresetCompatibleWithCertTable(p))
    if (!compatible.length) {
      status('没有与当前表格模板兼容的布局模板')
      return
    }

    let matched = 0
    let defaulted = 0
    const prevRowPresetIds = [...(options.getRowPresetIds?.() ?? [])]
    const nextRowPresetIds = [...prevRowPresetIds]
    for (let i = 0; i < rows.length; i++) {
      const cellValue = rows[i][columnId]
      const result = findBestPresetMatch(cellValue, compatible)
      const nextId = result?.preset?.id ?? null
      nextRowPresetIds[i] = nextId
      if (nextId) matched += 1
      else defaulted += 1
    }
    const groupErr = crossGroupPresetError({ rowPresetIds: nextRowPresetIds })
    if (groupErr) {
      status(groupErr)
      return
    }

    if (options.setRowPresetIds) {
      options.setRowPresetIds(nextRowPresetIds)
    } else {
      for (let i = 0; i < rows.length; i++) {
        options.setRowPresetId?.(i, nextRowPresetIds[i])
      }
    }

    if (currentCertId) {
      try {
        localStorage.setItem(`cat.smartLayoutCol.${currentCertId}`, columnId)
      } catch {
        // ignore
      }
    }

    loadedPresetId = null
    const selected = s.selectedRow ?? 0
    try {
      for (let i = 0; i < rows.length; i++) {
        if (nextRowPresetIds[i] === prevRowPresetIds[i]) continue
        await ensureLayoutForRow(i, { force: true, overwriteRowCustomSamples: true })
      }
      await ensureLayoutForRow(selected, { force: true, overwriteRowCustomSamples: true })
      await options.refreshPreviewForRow?.(selected)
      markDirty()
      options.onTableRefreshNeeded?.()
      status(`智能布局完成：${matched} 行已匹配模板，${defaulted} 行使用默认布局`)
    } catch (err) {
      status(err.message || '智能布局应用失败')
      options.onTableRefreshNeeded?.()
    }
  }

  function buildLayoutPresetSelectOptions({ includeBulkPlaceholder = false, selectedValue = null } = {}) {
    let html = ''
    if (includeBulkPlaceholder) {
      html += '<option value="">— 批量设置 —</option>'
    }
    const defaultSel = selectedValue === '__default__' || selectedValue == null ? ' selected' : ''
    html += `<option value="__default__"${defaultSel}>默认</option>`
    for (const p of presets) {
      const sel = selectedValue != null && String(selectedValue) === String(p.id) ? ' selected' : ''
      const gName = p.group_id != null
        ? accessGroups.find((g) => g.id === Number(p.group_id))?.name
        : null
      const gLabel = gName ? ` · ${gName}` : ''
      html += `<option value="${p.id}"${sel}>${escapeHtml(p.name)}${p.is_default ? ' ★' : ''}${escapeHtml(gLabel)}</option>`
    }
    return html
  }

  function getLayoutPresetTrailingColumns() {
    if (currentView !== 'edit') return []
    return [{ id: 'layout-preset', label: '布局模式', width: 148 }]
  }

  function renderLayoutPresetColHead(metaCol) {
    if (metaCol.id !== 'layout-preset') return escapeHtml(metaCol.label)
    const disabled = !presets.length ? ' disabled' : ''
    return `<label class="spreadsheet-layout-preset-head">`
      + `<span class="spreadsheet-layout-preset-head-label">${escapeHtml(metaCol.label)}</span>`
      + `<select class="spreadsheet-layout-preset-bulk wp-select wp-select-compact"${disabled} title="选择后为全部行设置布局">`
      + buildLayoutPresetSelectOptions({ includeBulkPlaceholder: true })
      + '</select></label>'
  }

  function renderLayoutPresetCell(rowIndex) {
    const rowPresetIds = options.getRowPresetIds?.() ?? []
    const rowId = rowPresetIds[rowIndex]
    const selectedValue = rowId != null && Number(rowId) > 0 ? Number(rowId) : '__default__'
    const disabled = !currentPresetId && selectedValue === '__default__' ? ' disabled' : ''
    return `<select class="spreadsheet-layout-preset-row wp-select wp-select-compact" data-row="${rowIndex}"${disabled} title="本行布局；默认则跟随证书默认布局">`
      + buildLayoutPresetSelectOptions({ selectedValue })
      + '</select>'
  }

  async function applyRowPresetChange(rowIndex, nextId) {
    logLayoutSwitch('applyRowPresetChange', { rowIndex, nextId, currentPresetId, loadedPresetId })
    if (!nextId && !currentPresetId) {
      options.onTableRefreshNeeded?.()
      return
    }
    const rowPresetIds = [...(options.getRowPresetIds?.() ?? [])]
    rowPresetIds[rowIndex] = nextId
    const groupErr = crossGroupPresetError({ rowPresetIds })
    if (groupErr) {
      status(groupErr)
      options.onTableRefreshNeeded?.()
      return
    }
    try {
      if (nextId) await assertPresetTableCompatible(nextId)
      options.setRowPresetId?.(rowIndex, nextId)
      const s = options.getEditorState()
      const selected = s.selectedRow ?? 0
      const displayed = options.getPreviewDisplayedRow?.() ?? -1
      const affectsPreview = selected === rowIndex || displayed === rowIndex
      if (affectsPreview) {
        await ensureLayoutForRow(rowIndex, { force: true, overwriteRowCustomSamples: true })
      } else {
        options.invalidateRowPresetCache?.(rowIndex)
        logLayoutSwitch('applyRowPresetChange: 跳过全局布局（非当前预览行）', { rowIndex, selected, displayed })
      }
      markDirty()
      options.onTableRefreshNeeded?.()
      status(nextId ? `第 ${rowIndex + 1} 行已设置布局` : `第 ${rowIndex + 1} 行已改为默认布局`)
    } catch (err) {
      warnLayoutSwitch('applyRowPresetChange:failed', { error: err.message })
      status(err.message || '设置行布局失败')
      options.onTableRefreshNeeded?.()
    }
  }

  function wireLayoutPresetControls(container) {
    if (container.dataset.layoutPresetWired === '1') return
    container.dataset.layoutPresetWired = '1'
    logLayoutSwitch('wireLayoutPresetControls:attached', { containerId: container.id || '(no-id)' })

    container.addEventListener('mousedown', (e) => {
      if (e.target.closest('.spreadsheet-layout-preset-bulk, .spreadsheet-layout-preset-row')) {
        e.stopPropagation()
      }
    }, true)

    container.addEventListener('click', (e) => {
      if (e.target.closest('.spreadsheet-layout-preset-bulk, .spreadsheet-layout-preset-row')) {
        e.stopPropagation()
      }
    }, true)

    container.addEventListener('change', async (e) => {
      logLayoutSwitch('layoutColumn:change', { target: e.target?.className, value: e.target?.value })
      const bulk = e.target.closest('.spreadsheet-layout-preset-bulk')
      if (bulk && container.contains(bulk)) {
        const val = bulk.value
        bulk.value = ''
        if (!val) return
        const nextId = val === '__default__' ? null : Number(val)
        if (!nextId && !currentPresetId) return
        const rowPresetIds = (options.getRowPresetIds?.() ?? []).map(() => nextId)
        const groupErr = crossGroupPresetError({ rowPresetIds })
        if (groupErr) {
          status(groupErr)
          options.onTableRefreshNeeded?.()
          return
        }
        try {
          if (nextId) await assertPresetTableCompatible(nextId)
          options.setAllRowPresetIds?.(nextId)
          const s = options.getEditorState()
          const row = s.selectedRow ?? 0
          loadedPresetId = null
          await ensureLayoutForRow(row, { force: true })
          await options.refreshPreviewForRow?.(row)
          markDirty()
          options.onTableRefreshNeeded?.()
          status(nextId ? '已为全部行设置布局' : '已全部行改为默认布局')
        } catch (err) {
          status(err.message || '批量设置布局失败')
          options.onTableRefreshNeeded?.()
        }
        return
      }

      const rowSel = e.target.closest('.spreadsheet-layout-preset-row')
      if (!rowSel || !container.contains(rowSel)) return
      const row = Number(rowSel.dataset.row)
      if (Number.isNaN(row)) return
      const val = rowSel.value
      const nextId = val === '__default__' ? null : Number(val)
      await applyRowPresetChange(row, nextId)
    })
  }

  function resolveEffectiveRowPresetId(rowIndex, rowPresetIds = options.getRowPresetIds?.() ?? []) {
    const rowId = rowPresetIds[rowIndex]
    if (rowId != null && Number(rowId) > 0) return Number(rowId)
    return currentPresetId
  }


  async function fetchPreset(presetId) {
    if (!presetId) return null
    const { preset } = await api.getPreset(presetId)
    if (preset) rememberPresetMeta(preset)
    return preset
  }

  function resolvePresetTableTemplateId(preset) {
    return preset?.table_template_id != null ? Number(preset.table_template_id) : null
  }

  /** 新布局模板的表格模板与证书当前表格模板是否不同（需替换表格数据） */
  function isPresetTableTemplateMismatch(preset) {
    const presetTableId = resolvePresetTableTemplateId(preset)
    if (!presetTableId) return false
    if (!currentPresetTableTemplateId) return false
    return presetTableId !== Number(currentPresetTableTemplateId)
  }

  async function assertPresetTableCompatible(presetId) {
    const preset = await fetchPreset(presetId)
    if (!preset) return null
    if (isPresetTableTemplateMismatch(preset)) {
      throw new Error(`布局模板「${preset.name}」与证书表格模板不一致（请通过「默认布局」切换以替换表格）`)
    }
    if (!currentPresetTableTemplateId && preset.table_template_id != null) {
      currentPresetTableTemplateId = Number(preset.table_template_id)
    }
    return preset
  }

  async function applyLayoutPresetBundle(presetId, {
    preserveTable = true,
    fromApplyButton = false,
    targetRowIndex = null,
    overwriteRowCustomSamples = false,
    overwriteDefaultRowCustomSamples = false,
  } = {}) {
    const preset = await assertPresetTableCompatible(presetId)
    if (!preset) return

    currentPresetSvgId = preset.svg_template_id ?? null
    if (preset.table_template_id != null) {
      currentPresetTableTemplateId = Number(preset.table_template_id)
    }

    const s = options.getEditorState()
    const bundle = await resolvePresetEditorBundle(
      preset,
      s.tableData || [],
      fromApplyButton ? null : (s.layoutOverrides || {}),
      { usePresetLayout: fromApplyButton },
    )

    if (preserveTable && options.applyPresetLayoutContext) {
      await options.applyPresetLayoutContext(bundle, {
        selectedRow: s.selectedRow ?? 0,
        targetRowIndex,
        overwriteRowCustomSamples,
        overwriteDefaultRowCustomSamples,
      })
    } else {
      await options.loadEditorState({
        ...s,
        layoutOverrides: bundle.layoutOverrides,
        fontScale: fromApplyButton ? bundle.fontScale : (s.fontScale ?? bundle.fontScale),
        templateId: bundle.templateId ?? s.templateId,
        columnOrder: bundle.columnOrder ?? s.columnOrder,
        tableData: preserveTable ? s.tableData : bundle.tableData,
        rowPresetIds: options.getRowPresetIds?.() ?? s.rowPresetIds ?? [],
        selectedRow: s.selectedRow ?? 0,
        strictColumnOrder: bundle.strictColumnOrder,
        tableTemplateColumns: bundle.tableTemplateColumns ?? null,
        presetCustomSamples: bundle.presetCustomSamples ?? {},
        presetSampleAdornments: bundle.presetSampleAdornments ?? {},
        pageWidthMm: bundle.pageWidthMm,
        pageHeightMm: bundle.pageHeightMm,
      })
    }
    loadedPresetId = presetId
    logLayoutSwitch('applyLayoutPresetBundle:done', layoutSwitchSnapshot('bundle-done', { presetId, fromApplyButton, preserveTable }))
  }

  async function ensureLayoutForRow(rowIndex, { force = false, overwriteRowCustomSamples = false } = {}) {
    const rowPresetIds = options.getRowPresetIds?.() ?? []
    const effectiveId = resolveEffectiveRowPresetId(rowIndex, rowPresetIds)
    logLayoutSwitch('ensureLayoutForRow', {
      rowIndex,
      effectiveId,
      loadedPresetId,
      force,
      skip: !force && effectiveId === loadedPresetId,
      rowPreset: rowPresetIds[rowIndex] ?? null,
      currentPresetId,
    })
    if (!force && effectiveId === loadedPresetId) return
    if (!effectiveId) {
      loadedPresetId = null
      warnLayoutSwitch('ensureLayoutForRow: 无有效 preset，跳过加载', { rowIndex })
      return
    }
    await applyLayoutPresetBundle(effectiveId, {
      preserveTable: true,
      fromApplyButton: true,
      targetRowIndex: rowIndex,
      overwriteRowCustomSamples,
    })
  }

  function normalizePresetLayoutOverrides(raw) {
    if (raw == null) return {}
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }
    return typeof raw === 'object' ? raw : {}
  }

  async function resolvePresetEditorBundle(preset, rows = [], certLayoutOverrides = null, { usePresetLayout = false } = {}) {
    let tableCols = []
    if (preset.table_template_id) {
      const { template } = await api.getTableTemplate(preset.table_template_id)
      tableCols = (template.columns || []).map((c) => String(c).trim()).filter(Boolean)
    }

    const rawLayout = usePresetLayout
      ? normalizePresetLayoutOverrides(preset.layout_overrides)
      : resolveCertificateLayoutOverrides(certLayoutOverrides, normalizePresetLayoutOverrides(preset.layout_overrides))
    const layoutOverrides = applyTableTemplateScopeFlag(
      pruneLayoutOverridesForTable(structuredClone(rawLayout), tableCols),
      tableCols,
    )

    const customSamples = customSampleDisplayFromPreset(
      preset.preview_sample_row,
      tableCols,
      layoutOverrides,
    )
    const presetSampleAdornments = sampleAdornmentsFromPreset(
      preset.preview_sample_row,
      tableCols,
      layoutOverrides,
    )
    const pageSize = pageSizeFromPreset(preset)

    const normalizedRows = (rows || []).map((r) => (
      r && typeof r === 'object' && r.row_data != null ? r.row_data : r
    ))
    const tableData = sanitizeCertificateRows(
      normalizedRows.length ? normalizedRows : [{}],
      tableCols,
      layoutOverrides,
      customSamples,
    )

    return {
      layoutOverrides,
      fontScale: preset.font_scale ?? 1,
      templateId: preset.svg_template_id ?? null,
      columnOrder: tableCols.length ? tableCols : null,
      tableData,
      presetSvgId: preset.svg_template_id ?? null,
      presetTableTemplateId: preset.table_template_id ?? null,
      strictColumnOrder: tableCols.length > 0,
      tableTemplateColumns: tableCols.length ? tableCols : null,
      presetCustomSamples: customSamples,
      presetSampleAdornments,
      pageWidthMm: pageSize.pageWidthMm,
      pageHeightMm: pageSize.pageHeightMm,
    }
  }

  /** 切换默认布局时：行内 preset 若等于旧默认，改为 null 以继承新默认 */
  function releaseRowPresetsForDefaultSwitch(oldPresetId) {
    if (!oldPresetId) return { released: [], kept: [] }
    const ids = options.getRowPresetIds?.() ?? []
    const released = []
    const kept = []
    ids.forEach((id, i) => {
      const rowId = id != null && Number(id) > 0 ? Number(id) : null
      if (rowId === Number(oldPresetId)) {
        options.setRowPresetId?.(i, null)
        released.push(i)
      } else if (rowId != null) {
        kept.push({ row: i, presetId: rowId })
      }
    })
    logLayoutSwitch('releaseRowPresetsForDefaultSwitch', { oldPresetId, released, kept })
    return { released, kept }
  }

  function layoutSwitchSnapshot(tag, extra = {}) {
    const s = options.getEditorState()
    const row = s.selectedRow ?? 0
    const rowPresetIds = options.getRowPresetIds?.() ?? []
    return {
      tag,
      currentPresetId,
      loadedPresetId,
      currentPresetTableTemplateId,
      selectedRow: row,
      rowPresetAtSelected: rowPresetIds[row] ?? null,
      effectiveRowPreset: resolveEffectiveRowPresetId(row, rowPresetIds),
      rowPresetIds: [...rowPresetIds],
      templateId: s.templateId,
      layoutOverrideKeys: Object.keys(s.layoutOverrides || {}).filter((k) => !k.startsWith('__')),
      ...extra,
    }
  }

  async function applyLayoutPreset(presetId, { fromApplyButton = false, preserveTable = false } = {}) {
    logLayoutSwitch('applyLayoutPreset:start', layoutSwitchSnapshot('start', { presetId, fromApplyButton, preserveTable }))
    const preset = await fetchPreset(presetId)
    if (!preset) {
      warnLayoutSwitch('applyLayoutPreset: preset 不存在', { presetId })
      return
    }
    currentPresetId = presetId
    syncPresetSelect(presetId)
    await syncCertGroupFromLayoutPreset(preset)

    const s = options.getEditorState()
    const bundle = await resolvePresetEditorBundle(
      preset,
      preserveTable ? (s.tableData || []) : [],
      fromApplyButton ? null : (s.layoutOverrides || {}),
      { usePresetLayout: fromApplyButton },
    )

    logLayoutSwitch('applyLayoutPreset:bundle', {
      presetId,
      presetName: preset.name,
      svgTemplateId: bundle.templateId,
      tableTemplateId: bundle.presetTableTemplateId,
      layoutOverrideKeys: Object.keys(bundle.layoutOverrides || {}).filter((k) => !k.startsWith('__')),
      customBoxIds: Object.keys(bundle.layoutOverrides || {}).filter((k) => (
        !k.startsWith('__') && !((bundle.columnOrder || []).includes(k))
      )),
      preserveTable,
    })

    currentPresetSvgId = bundle.presetSvgId
    currentPresetTableTemplateId = bundle.presetTableTemplateId

    if (preserveTable) {
      loadedPresetId = null
      await applyLayoutPresetBundle(presetId, {
        preserveTable: true,
        fromApplyButton,
        overwriteDefaultRowCustomSamples: true,
      })
    } else {
      await options.loadEditorState({
        ...s,
        layoutOverrides: bundle.layoutOverrides,
        fontScale: bundle.fontScale,
        templateId: bundle.templateId ?? s.templateId,
        columnOrder: bundle.columnOrder ?? s.columnOrder,
        tableData: bundle.tableData,
        rowPresetIds: (bundle.tableData || []).map(() => null),
        selectedRow: s.selectedRow ?? 0,
        strictColumnOrder: bundle.strictColumnOrder,
        tableTemplateColumns: bundle.tableTemplateColumns ?? null,
        presetCustomSamples: bundle.presetCustomSamples ?? {},
        presetSampleAdornments: bundle.presetSampleAdornments ?? {},
        pageWidthMm: bundle.pageWidthMm,
        pageHeightMm: bundle.pageHeightMm,
      })
      loadedPresetId = presetId
    }
    logLayoutSwitch('applyLayoutPreset:done', layoutSwitchSnapshot('done', { presetId, presetName: preset.name }))
    markDirty()
    status(`已应用布局模板：${preset.name}`)
    void syncPublicCertLink()
    syncNewCertPresetGate()
  }

  function syncPresetSelect(presetId = currentPresetId) {
    if (!presetSelect) return
    if (presetId != null && presets.some((p) => p.id === presetId)) {
      presetSelect.value = String(presetId)
    } else {
      presetSelect.value = ''
    }
  }

  function confirmPresetSwitch({ tableMismatch = false } = {}) {
    const sameTableMsg = '切换默认布局后，未单独指定布局的行将使用新默认模板，表格数据保留。是否继续？'
    const message = tableMismatch
      ? '新布局使用不同的表格模板，将<strong>清空并替换</strong>为模板默认表格结构，<strong>此操作不可恢复</strong>。是否继续？'
      : sameTableMsg
    if (!presetSwitchDialog) {
      return Promise.resolve(window.confirm(tableMismatch
        ? '新布局使用不同的表格模板，将清空并替换为模板默认表格结构，此操作不可恢复。是否继续？'
        : sameTableMsg))
    }
    presetSwitchDialog.classList.toggle('cms-preset-switch-dialog--danger', tableMismatch)
    const msgEl = presetSwitchDialog.querySelector('.cms-preset-switch-dialog__message')
    if (msgEl) {
      if (tableMismatch) {
        msgEl.innerHTML = message
      } else {
        msgEl.textContent = message
      }
    }
    return new Promise((resolve) => {
      const finish = (ok) => {
        presetSwitchYesBtn?.removeEventListener('click', onYes)
        presetSwitchNoBtn?.removeEventListener('click', onNo)
        presetSwitchDialog.removeEventListener('cancel', onCancel)
        presetSwitchDialog.close()
        resolve(ok)
      }
      const onYes = () => finish(true)
      const onNo = () => finish(false)
      const onCancel = (e) => {
        e.preventDefault()
        finish(false)
      }
      presetSwitchYesBtn?.addEventListener('click', onYes)
      presetSwitchNoBtn?.addEventListener('click', onNo)
      presetSwitchDialog.addEventListener('cancel', onCancel)
      presetSwitchDialog.showModal()
    })
  }

  async function refreshTemplates() {
    const res = await api.listTemplates()
    templates = res.templates || []
  }

  async function refreshTableTemplates() {
    try {
      const res = await api.listTableTemplates()
      tableTemplates = res.templates || []
    } catch {
      tableTemplates = []
    }
  }

  async function loadCertificate(id) {
    isDraftNewCert = false
    const { certificate } = await api.getCertificate(id)
    if (certificate.deleted_at) {
      status('该证书在回收站中，请先恢复后再编辑')
      setCertFilter('trash')
      return
    }
    currentCertId = certificate.id
    currentStatus = certificate.status
    currentPresetId = certificate.preset_id ?? null
    currentCertGroupId = certificate.group_id ?? null
    currentPublicSlug = certificate.public_slug ?? null
    publicSlugTouched = false
    loadedPresetId = null
    titleInput.value = certificate.title
    updateStatusBadge()
    syncPresetSelect(currentPresetId)

    const rowPresetIds = (certificate.rows || []).map((r) => (
      r.preset_id != null && Number(r.preset_id) > 0 ? Number(r.preset_id) : null
    ))
    const initialRow = 0
    const initialPresetId = rowPresetIds[initialRow] ?? currentPresetId

    let loadState = {
      tableData: certificate.rows.map((r) => r.row_data),
      rowPresetIds,
      columnOrder: certificate.column_order || null,
      layoutOverrides: certificate.layout_overrides || {},
      fontScale: certificate.font_scale ?? 1,
      templateId: certificate.template_id ?? templates[0]?.id ?? null,
      selectedRow: initialRow,
      title: certificate.title,
      previewUi: certificate.preview_ui ?? {},
    }

    if (initialPresetId) {
      const { preset } = await api.getPreset(initialPresetId)
      const bundle = await resolvePresetEditorBundle(
        preset,
        certificate.rows,
        certificate.layout_overrides,
      )
      loadState = {
        ...loadState,
        layoutOverrides: bundle.layoutOverrides,
        fontScale: certificate.font_scale ?? bundle.fontScale,
        templateId: bundle.templateId ?? loadState.templateId,
        columnOrder: resolveTemplateColumnOrder(bundle.tableTemplateColumns, certificate.column_order),
        tableData: bundle.tableData,
        strictColumnOrder: !!(bundle.tableTemplateColumns?.length),
        tableTemplateColumns: bundle.tableTemplateColumns ?? null,
        presetCustomSamples: bundle.presetCustomSamples ?? {},
        presetSampleAdornments: bundle.presetSampleAdornments ?? {},
        pageWidthMm: bundle.pageWidthMm,
        pageHeightMm: bundle.pageHeightMm,
      }
      currentPresetSvgId = bundle.presetSvgId
      currentPresetTableTemplateId = bundle.presetTableTemplateId
      loadedPresetId = initialPresetId
    } else {
      currentPresetSvgId = certificate.template_id ?? null
      currentPresetTableTemplateId = certificate.table_template_id ?? null
      if (certificate.table_template_id) {
        try {
          const { template } = await api.getTableTemplate(certificate.table_template_id)
          const tableCols = (template.columns || []).map((c) => String(c).trim()).filter(Boolean)
          if (tableCols.length) {
            loadState.tableTemplateColumns = tableCols
            loadState.columnOrder = resolveTemplateColumnOrder(tableCols, certificate.column_order)
            loadState.strictColumnOrder = true
          }
        } catch {
          // 表格模板不可用时沿用证书已保存列顺序
        }
      }
    }

    await options.loadEditorState(loadState)
    refreshSmartLayoutColumnOptions()
    options.onTableRefreshNeeded?.()
    if (tableSearchInput) {
      tableSearchInput.value = ''
      runTableSearch('')
    }

    const idx = certificates.findIndex((c) => c.id === id)
    if (idx >= 0) {
      certificates[idx] = {
        ...certificates[idx],
        template_id: currentPresetSvgId,
        preset_id: certificate.preset_id,
        table_template_id: currentPresetTableTemplateId,
      }
    }
    dirty = false
    status(`已加载：${certificate.title}`)
    await fetchSiteConfigForGroupId(resolveEffectiveCertGroupId())
    void syncPublicCertLink()
    syncNewCertPresetGate()
  }

  async function prepareNewCertificate() {
    clearTimeout(saveTimer)
    currentCertId = null
    isDraftNewCert = true
    currentStatus = 'draft'
    currentPresetId = null
    loadedPresetId = null
    currentPresetSvgId = null
    currentPresetTableTemplateId = null
    currentCertGroupId = null
    currentPublicSlug = null
    publicSlugTouched = false
    const title = untitledName()
    titleInput.value = title
    updateStatusBadge()
    syncPresetSelect(null)

    await options.loadEditorState({
      tableData: [],
      rowPresetIds: [],
      columnOrder: null,
      layoutOverrides: {},
      fontScale: 1,
      templateId: templates[0]?.id ?? null,
      selectedRow: 0,
      title,
      previewUi: {},
    })
    refreshSmartLayoutColumnOptions()
    options.onTableRefreshNeeded?.()
    if (tableSearchInput) {
      tableSearchInput.value = ''
      runTableSearch('')
    }
    dirty = false
    void syncPublicCertLink()
    syncNewCertPresetGate()
    requestAnimationFrame(() => presetSelect?.focus())
  }

  async function saveCertificate(silent = false) {
    if (!requirePresetForNewCert('保存')) return
    const payload = editorPayload()
    if (!currentCertId) {
      const { id } = await api.createCertificate(payload)
      currentCertId = id
      isDraftNewCert = false
      currentPublicSlug = payload.public_slug ?? null
      publicSlugTouched = false
      await refreshCertList(id)
      dirty = false
      void syncPublicCertLink()
      if (!silent) status('已创建并保存')
      return
    }
    await api.updateCertificate(currentCertId, payload)
    dirty = false
    const idx = certificates.findIndex((c) => c.id === currentCertId)
    if (idx >= 0) {
      certificates[idx] = {
        ...certificates[idx],
        template_id: payload.template_id,
        preset_id: payload.preset_id,
        table_template_id: payload.table_template_id,
        public_slug: publicSlugTouched ? (currentPublicSlug ?? null) : certificates[idx].public_slug,
      }
    }
    await refreshCertList(currentCertId)
    if (!silent) status('已保存到服务器')
  }

  function scheduleAutosave() {
    clearTimeout(saveTimer)
    if (isDraftNewCert && !currentCertId) return
    saveTimer = setTimeout(() => {
      if (!dirty) return
      saveCertificate(true).catch((err) => console.warn('[CMS] 自动保存失败', err))
    }, 3000)
  }

  titleInput.addEventListener('input', () => {
    markDirty()
    if (!publicSlugTouched && !currentCertId) {
      void syncPublicCertLink()
    }
  })

  const onNewCert = async () => {
    if (currentView === 'edit') {
      if (dirty) {
        if (!window.confirm('当前有未保存修改，继续新建将丢弃，是否继续？')) return
        dirty = false
      } else if (isDraftNewCert && !currentCertId) {
        await prepareNewCertificate()
        await showView('edit', { skipDirtyCheck: true })
        status(`新建${E()}`)
        return
      }
    }
    try {
      await prepareNewCertificate()
      await showView('edit', { skipDirtyCheck: true })
      status(`新建${E()}`)
    } catch (err) {
      status(err.message || '创建失败')
    }
  }

  root.querySelectorAll('#cms-cert-new, .cms-cert-new-trigger').forEach((btn) => {
    btn.addEventListener('click', onNewCert)
  })

  setupDataTransferMenu(root, {
    prefix: 'cms-cert',
    onExport: async () => {
      const ids = selectedCertificateIds()
      if (!ids.length) return
      try {
        const bundle = await api.exportCertificates(ids)
        const stamp = new Date().toISOString().slice(0, 10)
        downloadJsonFile(`certificates-${stamp}.json`, bundle)
        status(`已导出 ${certBatchCountLabel(bundle.item_count ?? ids.length)}`)
      } catch (err) {
        status(err.message || '导出失败')
      }
    },
    onImport: async () => {
      try {
        const mode = askImportConflictMode()
        if (!mode) return
        const bundle = await readJsonFile()
        const result = await api.importCertificates(bundle, mode)
        alertImportDetails(result)
        await refreshCertList(result.ids?.[0] ?? null)
        status(formatImportResultMessage(result))
      } catch (err) {
        if (err.message !== '已取消') status(err.message || '导入失败')
      }
    },
  })

  root.querySelector('#cms-back-list').addEventListener('click', () => {
    goToList().catch((err) => status(err.message))
  })

  root.querySelectorAll('.wp-pill[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setCertFilter(btn.dataset.filter || 'all')
    })
  })

  root.querySelectorAll('.wp-nav-filter-link[data-cert-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setCertFilter(btn.dataset.certFilter || 'all')
      if (currentView !== 'list') {
        showView('list').catch((err) => status(err.message || '切换视图失败'))
      }
    })
  })

  certSearchInput.addEventListener('input', () => {
    certSearch = certSearchInput.value
    renderCertTable()
  })

  root.querySelector('#cms-cert-group-by')?.addEventListener('change', (e) => {
    certGroupBy = e.target.value || 'none'
    renderCertTable()
  })

  root.querySelector('#cms-cert-select-all')?.addEventListener('change', (e) => {
    const list = filteredCertificates()
    const checked = e.target.checked
    for (const c of list) {
      if (checked) certSelectedIds.add(c.id)
      else certSelectedIds.delete(c.id)
    }
    renderCertTable()
  })

  function selectedCertificateIds() {
    const list = filteredCertificates()
    return list.filter((c) => certSelectedIds.has(c.id)).map((c) => c.id)
  }

  root.querySelector('#cms-cert-batch-edit')?.addEventListener('click', () => {
    const ids = selectedCertificateIds()
    if (ids.length === 1) selectCertificate(ids[0])
  })

  root.querySelector('#cms-cert-batch-delete')?.addEventListener('click', () => {
    trashCertificates(selectedCertificateIds())
  })

  root.querySelector('#cms-cert-batch-restore')?.addEventListener('click', () => {
    restoreCertificates(selectedCertificateIds())
  })

  root.querySelector('#cms-cert-batch-purge')?.addEventListener('click', () => {
    purgeCertificates(selectedCertificateIds())
  })

  root.querySelector('#cms-cert-batch-copy')?.addEventListener('click', () => {
    duplicateCertificates(selectedCertificateIds())
  })

  root.querySelector('#cms-cert-batch-group')?.addEventListener('click', () => {
    const ids = selectedCertificateIds()
    if (!ids.length) return
    const groupName = window.prompt('设置分组名称（留空表示未分组）', '')
    if (groupName == null) return
    assignGroupToCertificates(ids, groupName)
  })

  certListEl.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.wp-cert-public-copy')
    if (copyBtn instanceof HTMLButtonElement) {
      e.stopPropagation()
      void copyTextToClipboard(copyBtn.dataset.url || '', '前端链接已复制')
      return
    }
    if (e.target.closest('.wp-cert-public-link')) {
      e.stopPropagation()
      return
    }
    if (e.target.closest('.wp-cert-row-check, .wp-cert-col-check, .wp-cert-group-input, .wp-cert-cell-group, .wp-cert-cell-link')) return
    const row = e.target.closest('.wp-cert-row')
    if (row) selectCertificate(Number(row.dataset.id))
  })

  certListEl.addEventListener('change', (e) => {
    const cb = e.target.closest('.wp-cert-row-check')
    if (!cb) return
    const id = Number(cb.dataset.id)
    if (cb.checked) certSelectedIds.add(id)
    else certSelectedIds.delete(id)
    cb.closest('.wp-cert-row')?.classList.toggle('is-selected', cb.checked)
    updateCertBatchBar()
  })

  certListEl.addEventListener('keydown', (e) => {
    const input = e.target.closest('.wp-cert-group-input')
    if (!input || e.key !== 'Enter') return
    e.preventDefault()
    input.blur()
  })

  certListEl.addEventListener('focusout', (e) => {
    const input = e.target.closest('.wp-cert-group-input')
    if (!input) return
    updateCertificateGroup(Number(input.dataset.id), input.value)
  })

  smartLayoutColSelect?.addEventListener('change', () => {
    syncSmartLayoutApplyButton()
  })

  smartLayoutColSelect?.addEventListener('focus', () => {
    refreshSmartLayoutColumnOptions()
  })

  smartLayoutApplyBtn?.addEventListener('click', () => {
    if (!requirePresetForNewCert('使用智能布局')) return
    applySmartLayoutPresets().catch((err) => status(err.message || '智能布局失败'))
  })

  presetSelect?.addEventListener('change', async () => {
    const nextPresetId = presetSelect.value ? Number(presetSelect.value) : null
    logLayoutSwitch('presetSelect:change', layoutSwitchSnapshot('before-change', { nextPresetId }))
    if (nextPresetId === currentPresetId) {
      logLayoutSwitch('presetSelect: 与当前相同，跳过')
      return
    }

    let nextPreset = null
    if (nextPresetId) {
      nextPreset = await fetchPreset(nextPresetId)
      if (!nextPreset) {
        syncPresetSelect(currentPresetId)
        status('布局模板不存在')
        return
      }
    }

    const tableMismatch = !!(nextPreset && isPresetTableTemplateMismatch(nextPreset))
    logLayoutSwitch('presetSelect: 表格模板', {
      tableMismatch,
      currentTableTemplateId: currentPresetTableTemplateId,
      nextTableTemplateId: resolvePresetTableTemplateId(nextPreset),
      nextPresetName: nextPreset?.name,
    })
    const rowPresetIds = options.getRowPresetIds?.() ?? []
    const groupErr = crossGroupPresetError({ defaultPresetId: nextPresetId, rowPresetIds })
    if (groupErr) {
      syncPresetSelect(currentPresetId)
      status(groupErr)
      return
    }

    if (!nextPresetId) {
      if (isDraftNewCert && !currentCertId) {
        syncPresetSelect(null)
        status('新建证书请先选择默认布局')
        return
      }
      const ok = await confirmPresetSwitch({ tableMismatch: false })
      if (!ok) {
        syncPresetSelect(currentPresetId)
        return
      }
      currentPresetId = null
      loadedPresetId = null
      currentPresetSvgId = null
      currentPresetTableTemplateId = null
      if (isDraftNewCert && !currentCertId) currentCertGroupId = null
      markDirty()
      status('已取消关联默认布局')
      void syncPublicCertLink()
      syncNewCertPresetGate()
      return
    }

    const isFirstPresetPick = isDraftNewCert && !currentCertId && !currentPresetId
    if (!isFirstPresetPick) {
      const ok = await confirmPresetSwitch({ tableMismatch })
      if (!ok) {
        syncPresetSelect(currentPresetId)
        return
      }
    }

    try {
      const oldPresetId = currentPresetId
      const s = options.getEditorState()
      const row = s.selectedRow ?? 0
      loadedPresetId = null

      if (tableMismatch) {
        options.setAllRowPresetIds?.(null)
      } else {
        releaseRowPresetsForDefaultSwitch(oldPresetId)
      }

      await applyLayoutPreset(nextPresetId, {
        fromApplyButton: true,
        preserveTable: !tableMismatch,
      })

      await options.refreshPreviewForRow?.(row)
      logLayoutSwitch('presetSelect:done', layoutSwitchSnapshot('after-change', {
        nextPresetId,
        tableMismatch,
      }))
      markDirty()
      syncPresetSelect(currentPresetId)
      options.onTableRefreshNeeded?.()
      status(tableMismatch
        ? `已切换为「${nextPreset.name}」并替换表格结构`
        : `已更新默认布局：${nextPreset.name}`)
      void syncPublicCertLink()
      syncNewCertPresetGate()
    } catch (err) {
      warnLayoutSwitch('presetSelect:failed', { error: err.message, stack: err.stack })
      status(err.message || '切换默认布局失败')
      syncPresetSelect(currentPresetId)
    }
  })

  root.querySelector('#cms-save').addEventListener('click', () => {
    if (!requirePresetForNewCert('保存')) return
    saveCertificate(false).catch((err) => status(err.message))
  })

  document.getElementById('cms-public-cert-link')?.addEventListener('click', () => {
    const el = document.getElementById('cms-public-cert-link')
    const url = el?.dataset.url || el?.textContent?.trim()
    void copyTextToClipboard(url, '链接已复制')
  })

  document.getElementById('cms-public-cert-link-edit')?.addEventListener('click', () => {
    if (!requirePresetForNewCert('修改链接')) return
    void openPublicSlugDialog()
  })

  publicSlugDialog?.querySelector('#cms-public-slug-cancel')?.addEventListener('click', () => {
    publicSlugDialog.close('cancel')
  })

  publicSlugDialog?.querySelector('#cms-public-slug-clear')?.addEventListener('click', () => {
    void applyPublicSlugFromDialog('', true).then((ok) => {
      if (ok) publicSlugDialog.close('ok')
    })
  })

  publicSlugDialog?.querySelector('#cms-public-slug-save')?.addEventListener('click', () => {
    void applyPublicSlugFromDialog(publicSlugInput?.value ?? '').then((ok) => {
      if (ok) publicSlugDialog.close('ok')
    })
  })

  publicSlugInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      publicSlugDialog?.querySelector('#cms-public-slug-save')?.click()
    }
  })

  root.querySelector('#cms-cert-delete').addEventListener('click', async () => {
    if (!currentCertId) {
      status(siteText('selectEntityFirst'))
      return
    }
    await trashCertificates([currentCertId])
  })

  root.querySelector('#cms-publish').addEventListener('click', async () => {
    if (!requirePresetForNewCert('发布')) return
    if (!currentCertId) {
      status(siteText('saveEntityFirst'))
      return
    }
    await saveCertificate(true)
    if (currentStatus === 'published') {
      await api.unpublishCertificate(currentCertId)
      currentStatus = 'draft'
      status('已撤回发布')
    } else {
      const pubRes = await api.publishCertificate(currentCertId)
      currentStatus = 'published'
      if (pubRes.group_id != null) currentCertGroupId = pubRes.group_id
      const pubCfg = await resolveSiteConfigForCertGroup(currentCertGroupId)
      const publicUrl = buildPublicCertUrl(
        { id: currentCertId, publicSlug: currentPublicSlug },
        pubCfg,
      )
      status(publicUrl ? `已发布。前端链接：${publicUrl}` : '已发布，前端可见')
      void syncPublicCertLink()
    }
    updateStatusBadge()
    await refreshCertList(currentCertId)
  })

  root.querySelector('#cms-revisions').addEventListener('click', async () => {
    if (!requirePresetForNewCert('查看修订')) return
    if (!currentCertId) return status(siteText('selectEntityFirst'))
    const { revisions } = await api.listCertificateRevisions(currentCertId)
    revisionsList.innerHTML = revisions.length === 0
      ? '<li>暂无修订</li>'
      : revisions.map((r) => `
        <li>
          <span>#${r.revision_number} · ${escapeHtml(r.note || '保存')} · ${formatTime(r.created_at)}</span>
          <button type="button" class="btn btn-sm" data-rev="${r.id}">恢复</button>
        </li>
      `).join('')
    revisionsList.querySelectorAll('button[data-rev]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const revId = Number(btn.dataset.rev)
        if (!window.confirm('恢复此修订？当前未保存内容将丢失。')) return
        const res = await api.restoreCertificateRevision(currentCertId, revId)
        currentPresetId = res.certificate.preset_id ?? null
        titleInput.value = res.certificate.title
        syncPresetSelect(currentPresetId)

        loadedPresetId = null
        let loadState = {
          tableData: res.certificate.rows.map((r) => r.row_data),
          rowPresetIds: (res.certificate.rows || []).map((r) => (
            r.preset_id != null && Number(r.preset_id) > 0 ? Number(r.preset_id) : null
          )),
          columnOrder: res.certificate.column_order || null,
          layoutOverrides: res.certificate.layout_overrides || {},
          fontScale: res.certificate.font_scale ?? 1,
          templateId: res.certificate.template_id ?? null,
          selectedRow: 0,
          title: res.certificate.title,
          previewUi: res.certificate.preview_ui || {},
        }

        if (currentPresetId) {
          const initialPresetId = loadState.rowPresetIds[0] ?? currentPresetId
          const { preset } = await api.getPreset(initialPresetId)
          const bundle = await resolvePresetEditorBundle(
            preset,
            res.certificate.rows,
            res.certificate.layout_overrides,
          )
          loadState = {
            ...loadState,
            layoutOverrides: bundle.layoutOverrides,
            fontScale: res.certificate.font_scale ?? bundle.fontScale,
            templateId: bundle.templateId ?? loadState.templateId,
            columnOrder: resolveTemplateColumnOrder(bundle.tableTemplateColumns, res.certificate.column_order),
            tableData: bundle.tableData,
            strictColumnOrder: bundle.strictColumnOrder,
            tableTemplateColumns: bundle.tableTemplateColumns ?? null,
            presetCustomSamples: bundle.presetCustomSamples ?? {},
            presetSampleAdornments: bundle.presetSampleAdornments ?? {},
          }
          currentPresetSvgId = bundle.presetSvgId
          currentPresetTableTemplateId = bundle.presetTableTemplateId
          loadedPresetId = initialPresetId
        } else {
          currentPresetSvgId = res.certificate.template_id ?? null
          currentPresetTableTemplateId = res.certificate.table_template_id ?? null
        }

        await options.loadEditorState(loadState)
        options.onTableRefreshNeeded?.()
        revisionsDialog.close()
        markDirty()
        status('已恢复修订')
      })
    })
    revisionsDialog.showModal()
  })

  root.querySelector('#cms-revisions-close').addEventListener('click', () => revisionsDialog.close())

  root.querySelector('#cms-logout').addEventListener('click', async () => {
    await api.logout()
    await redirectToAdminLogin()
  })

  root.querySelector('#cms-open-account')?.addEventListener('click', () => {
    accountCenter.open()
  })

  // ---- 侧栏折叠 ----
  const COLLAPSE_STORAGE_KEY = 'cat5-admin-sidebar-collapsed'
  const sidebarEl = root.querySelector('#wp-admin-menu')
  const collapseBtn = root.querySelector('#wp-sidebar-collapse-btn')
  function setSidebarCollapsed(collapsed) {
    sidebarEl?.classList.toggle('is-collapsed', collapsed)
    if (collapseBtn) {
      collapseBtn.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏')
      collapseBtn.innerHTML = collapsed ? '▶' : '◀'
    }
    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0') } catch { /* ignore */ }
  }
  collapseBtn?.addEventListener('click', () => {
    const next = !sidebarEl?.classList.contains('is-collapsed')
    setSidebarCollapsed(next)
  })
  // 恢复上次状态
  try {
    if (localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1') setSidebarCollapsed(true)
  } catch { /* ignore */ }

  root.querySelectorAll('.wp-nav-link[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view
      if (btn.dataset.certFilter) setCertFilter(btn.dataset.certFilter)
      if (!view) return
      if (view === currentView) return
      showView(view).catch((err) => status(err.message || '切换视图失败'))
    })
  })

  window.addEventListener('popstate', () => {
    const view = resolveViewFromLocation()
    const locParams = new URLSearchParams(window.location.search)
    const certId = locParams.get('cert') ? Number(locParams.get('cert')) : null
    if (view === currentView && (view !== 'edit' || certId === currentCertId)) return
    showView(view, { history: 'none' }).catch((err) => status(err.message || '切换视图失败'))
  })

  bootLayoutSwitchDebugHint()

  applySiteBranding()

  window.__CAT_CMS__ = {
    markDirty,
    saveCertificate,
    mountEditor,
    setEditingMode,
    showView,
    getCurrentCertId: () => currentCertId,
    getDefaultPresetId: () => currentPresetId,
    getLoadedPresetId: () => loadedPresetId,
    debugLayoutSwitch: () => layoutSwitchSnapshot('console'),
    enableLayoutSwitchDebug() {
      localStorage.setItem('cat.debugLayoutSwitch', '1')
      console.info('[CAT布局切换] 已开启，请刷新页面后重试切换')
    },
    ensureLayoutForRow,
    getLayoutPresetTrailingColumns,
    renderLayoutPresetColHead,
    renderLayoutPresetCell: (rowIndex, metaCol) => {
      if (metaCol.id !== 'layout-preset') return ''
      return renderLayoutPresetCell(rowIndex)
    },
    wireLayoutPresetControls,
    async getLinkedPresetPageSize() {
      if (!currentPresetId) return null
      try {
        const { preset } = await api.getPreset(currentPresetId)
        return pageSizeFromPreset(preset)
      } catch {
        return null
      }
    },
  }

  return {
    markDirty,
    mountEditor,
    setEditingMode,
    async init() {
      applyNavModuleVisibility()
      syncPublicPageNavLink()
      try {
        accessGroups = await loadAccessibleGroups(true)
        await Promise.all([refreshCertList(), refreshPresets(), refreshTemplates(), refreshTableTemplates()])
      } catch (err) {
        status(err.message || '加载数据失败：请确认 npm run dev:local 已启动，然后刷新页面')
        console.error('[CMS] init load failed', err)
      }
      syncViewPanels()

      const bootView = initialView === 'block-templates' ? 'layout-presets' : initialView
      if (SETTINGS_VIEWS.has(bootView)) {
        await showView(bootView, { skipDirtyCheck: true, history: 'replace' })
        return
      }

      if (initialCertId || initialView === 'edit') {
        const id = initialCertId || Number(new URLSearchParams(window.location.search).get('cert'))
        if (id) {
          await loadCertificate(id)
          await showView('edit', { skipDirtyCheck: true, history: 'replace' })
          highlightCertRow(id)
          return
        }
      }

      await showView('overview', { skipDirtyCheck: true, history: 'replace' })
    },
  }
}

function formatAdminRoleLabel(user) {
  if (user?.is_super_admin) return '超级管理员'
  const n = user?.group_ids?.length || 0
  if (n === 0) return '管理员（未分配组）'
  if (n === 1) return '管理员'
  return `管理员 · ${n} 个组`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;')
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN')
  } catch {
    return iso
  }
}
