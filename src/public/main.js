import { api } from '../api/client.js'
import { resolvePublicLoginHref } from '../publicLoginRedirect.js'
import { requireVisitorSession } from './guard.js'
import { mountAccountCenter } from '../admin/accountCenter.js'
import {
  loadSiteConfig,
  loadSiteConfigForGroup,
  siteText,
  applyPublicPageBranding,
  getSiteConfig,
  setSiteConfig,
} from '../siteConfig.js'
import { parsePublicCertSegmentFromLocation, parseCertIdFromPublicLocation, buildPublicCertLocationUrl } from '../publicCertUrl.js'
import { buildCertificateTableSearchText } from '../certificateSearch.js'
import { normalizeSearchText, searchTextIncludes } from '../searchNormalize.js'
import {
  generateSvgFromRow,
  resolveColumnFromPreviewClick,
  setSvgFieldHighlight,
  serializeSvgForExport,
  setActiveFontCatalog,
} from '../svgEngine.js'
import { exportSvgToPdf, exportRowsToSinglePdf } from '../pdfExport.js'
import { loadFontCatalog, ensureCatalogFontFaces } from '../fontCatalog.js'
import { applySampleAdornmentsToDisplayRow } from '../presetSampleRow.js'
import {
  diffAdornRow,
  exposePublicAdornDebug,
  groupPublicAdorn,
  isPublicAdornDebugEnabled,
  logPublicAdorn,
  readSvgDataLayerTexts,
  shouldWarnSvgMissingAdorn,
  warnPublicAdorn,
  warnPublicAdornCritical,
} from './publicAdornDebug.js'
import { mountPreviewViewport } from '../previewViewport.js'
import { mountLayoutEditor } from '../layoutEditor.js'
import { mountSpreadsheetTable } from '../spreadsheetTable.js'
import { EMPTY_SVG_TEMPLATE } from '../svgTemplateLoader.js'
import {
  DEFAULT_PAGE_WIDTH_MM,
  DEFAULT_PAGE_HEIGHT_MM,
  normalizePageSizeMm,
} from '../pageSize.js'
import {
  parsePageNavColumns,
  getPageNavRowValues,
} from '../pageNavColumn.js'

/** @type {import('../fontCatalog.js').FontCatalog | null} */
let fontCatalog = null
/** 首屏 SVG 注入 @font-face 后跳过重复注入 */
let previewFontReady = false
/** 目录字体是否已全部加载（用于预览：先出图后换字体） */
let catalogFontsLoaded = false
/** @type {Promise<void> | null} */
let catalogFontsWarmupPromise = null

/** @type {string} */
let fontUrl = ''

const previewPanelEl = document.querySelector('.public-preview-panel')
const previewSideEl = document.getElementById('public-preview-side')
const mainHeadEl = document.querySelector('.public-main-head')
const listEl = document.getElementById('public-cert-list')
const certSearchInput = document.getElementById('public-cert-search')
const certSearchSummary = document.getElementById('public-cert-search-summary')
const titleEl = document.getElementById('public-cert-title')
const previewArea = document.getElementById('public-preview-area')
const btnPreviewFullscreen = document.getElementById('public-preview-fullscreen')
const btnPreviewFullscreenExit = document.getElementById('public-preview-fullscreen-exit')
const tableWrap = document.getElementById('public-table-wrap')
const pageNavEl = document.getElementById('public-page-nav')
const pageNavResizeEl = document.getElementById('public-page-nav-resize')
const pageIndexEl = document.getElementById('public-page-index')
const pageIndexDrawerEl = document.getElementById('public-page-index-drawer')
const pageCurrentEl = document.getElementById('public-page-current')
const pageTotalEl = document.getElementById('public-page-total')
const pagesToggle = document.getElementById('public-pages-toggle')
const pagesDrawer = document.getElementById('public-pages-drawer')
const pagesBackdrop = document.getElementById('public-pages-backdrop')
const pagesClose = document.getElementById('public-pages-close')
const rowCardEl = document.getElementById('public-row-card')
const rowCardPageEl = document.getElementById('public-row-card-page')
const rowCardPresetEl = document.getElementById('public-row-card-preset')
const rowCardFieldsEl = document.getElementById('public-row-card-fields')
const prevBtn = document.getElementById('public-prev')
const nextBtn = document.getElementById('public-next')
const zoomValueEl = document.getElementById('public-zoom-value')
const publicContent = document.querySelector('.public-content')
const tablePanel = document.querySelector('.public-table-panel')
const splitHandle = document.getElementById('public-split-handle')
const exportStatusEl = document.getElementById('public-export-status')
const exportProgressEl = document.getElementById('public-export-progress')
const exportProgressTitle = document.getElementById('public-export-progress-title')
const exportProgressPct = document.getElementById('public-export-progress-pct')
const exportProgressFill = document.getElementById('public-export-progress-fill')
const exportProgressDetail = document.getElementById('public-export-progress-detail')
const exportProgressPage = document.getElementById('public-export-progress-page')
const exportProgressTime = document.getElementById('public-export-progress-time')
const exportProgressSteps = document.getElementById('public-export-progress-steps')
const btnExportSvg = document.getElementById('public-export-svg')
const btnExportPdf = document.getElementById('public-export-pdf')
const btnExportBatch = document.getElementById('public-export-batch')
const menuToggle = document.getElementById('public-menu-toggle')
const menuBackdrop = document.getElementById('public-menu-backdrop')
const settingsToggle = document.getElementById('public-settings-toggle')
const settingsDrawer = document.getElementById('public-settings-drawer')
const settingsBackdrop = document.getElementById('public-settings-backdrop')
const settingsClose = document.getElementById('public-settings-close')
const listPanel = document.getElementById('public-list-panel')
const showLayoutBoxesInput = document.getElementById('public-show-layout-boxes')
const showTemplateLayerInput = document.getElementById('public-show-template-layer')

const SPLIT_STORAGE_KEY = 'cat.public.tableSplitPx'
const PAGE_NAV_WIDTH_STORAGE_KEY = 'cat.public.pageNavWidthPx'
const DEFAULT_PAGE_NAV_WIDTH = 168
const MIN_PAGE_NAV_WIDTH = 100
const MAX_PAGE_NAV_WIDTH = 360
const MIN_TABLE_HEIGHT = 100
const MIN_PREVIEW_HEIGHT = 160

/** @type {{ id: number, title: string, table_search_text?: string, published_at?: string }[]} */
let catalog = []
let certSearch = ''
/** @type {object | null} */
let currentCert = null
let selectedRow = 0
let selectedCol = -1
let selectedColumnName = ''
let templateSvg = EMPTY_SVG_TEMPLATE
/** @type {number | null} */
let activeRenderPresetId = null
/** @type {Record<string, object>} */
let presetBundles = {}
let pageWidthMm = DEFAULT_PAGE_WIDTH_MM
let pageHeightMm = DEFAULT_PAGE_HEIGHT_MM
/** @type {string[] | null} */
let columnOrder = null
let loadGeneration = 0
let switchGeneration = 0
/** 预览区当前已显示的表格行（-1 表示无）；与 selectedRow 分离以便 UI 即时响应 */
let previewDisplayedRow = -1
let previewFitPending = false
/** @type {number | null} */
let pendingCertId = null
let certLoadRunner = false
/** @type {ReturnType<typeof setTimeout> | 0} */
let preloadTimer = 0
/** @type {Map<string, SVGSVGElement>} */
const rowSvgCache = new Map()
/** @type {ReturnType<typeof mountSpreadsheetTable> | null} */
let spreadsheet = null
/** @type {ReturnType<typeof mountLayoutEditor> | null} */
let layoutEditor = null
let showLayoutBoxes = false
let showTemplateLayer = true
/** @type {string[] | null} */
let tableTemplateColumns = null
/** @type {Record<string, { prefix: string[], suffix: string[] }>} 布局模板编辑框前后缀 */
let sampleAdornments = {}

const previewViewport = mountPreviewViewport(previewArea, {
  enableTouchGestures: true,
  enablePageSwipe() {
    return !isPublicMobileLandscapeLayout()
  },
  canSwipePage(dir) {
    const rows = getRows()
    if (dir === 'prev') return selectedRow > 0
    if (dir === 'next') return selectedRow < rows.length - 1
    return false
  },
  onSwipePage(dir) {
    return new Promise((resolve) => {
      const rows = getRows()
      if (dir === 'prev' && selectedRow > 0) scheduleSelectRow(selectedRow - 1, {}, resolve)
      else if (dir === 'next' && selectedRow < rows.length - 1) scheduleSelectRow(selectedRow + 1, {}, resolve)
      else resolve()
    })
  },
  onScaleChange(scale) {
    if (zoomValueEl) zoomValueEl.textContent = `${Math.round(scale * 100)}%`
  },
})

function getFillOptions(overrides = {}) {
  return {
    fontScale: currentCert?.font_scale ?? 1,
    layoutOverrides: getLayoutOverrides(),
    showReferenceLayer: false,
    showTemplateLayer,
    skipFontInject: !catalogFontsLoaded,
    fontCatalog,
    pageWidthMm,
    pageHeightMm,
    ...overrides,
  }
}

function setPreviewLoadingMessage(msg) {
  if (!previewArea) return
  let el = previewArea.querySelector('.public-preview-loading')
  if (!msg) {
    el?.remove()
    previewArea.classList.remove('public-preview-area--loading')
    return
  }
  previewArea.classList.add('public-preview-area--loading')
  if (!el) {
    el = document.createElement('p')
    el.className = 'public-empty public-preview-loading'
    previewArea.appendChild(el)
  }
  el.textContent = msg
}

async function warmupCatalogFonts(catalog) {
  if (!catalog?.sources?.length) {
    catalogFontsLoaded = true
    previewFontReady = true
    return
  }
  if (catalogFontsWarmupPromise) return catalogFontsWarmupPromise
  catalogFontsWarmupPromise = (async () => {
    try {
      await ensureCatalogFontFaces(catalog)
      catalogFontsLoaded = true
      previewFontReady = true
      if (currentCert?.rows?.length) {
        previewDisplayedRow = -1
        rowSvgCache.clear()
        scheduleSelectRow(selectedRow, { keepColumn: true })
      }
    } catch (err) {
      console.warn('[public] 字体加载失败，预览将使用回退字体', err)
    }
  })()
  return catalogFontsWarmupPromise
}

function destroyLayoutEditor() {
  if (layoutEditor) {
    layoutEditor.destroy()
    layoutEditor = null
  }
}

function attachLayoutEditorToStage() {
  const stage = getStage()
  const svgEl = stage?.querySelector('svg')
  if (!stage || !svgEl) return
  destroyLayoutEditor()
  layoutEditor = mountLayoutEditor(stage, svgEl, {
    layoutOverrides: getLayoutOverrides(),
    visible: showLayoutBoxes,
    readOnly: true,
    onCommit() {},
  })
}

function getLayoutOverrides() {
  return currentCert?.merged_layout_overrides
    || currentCert?.layout_overrides
    || {}
}

function resolveRowPresetId(rowIndex) {
  const row = currentCert?.rows?.[rowIndex]
  const rowId = row?.preset_id != null ? Number(row.preset_id) : null
  if (rowId) return rowId
  const certId = currentCert?.preset_id != null ? Number(currentCert.preset_id) : null
  return certId || null
}

function layoutPresetLabelForRow(rowIndex) {
  const row = currentCert?.rows?.[rowIndex]
  const rowId = row?.preset_id != null && Number(row.preset_id) > 0 ? Number(row.preset_id) : null
  if (!rowId) return '默认'
  const bundle = presetBundles[String(rowId)]
  if (bundle?.preset_name) return bundle.preset_name
  return `布局 #${rowId}`
}

function getPresetBundle(presetId) {
  if (!presetId) return null
  return presetBundles[String(presetId)] || null
}

function rowCacheKey(rowIndex) {
  const fontTag = catalogFontsLoaded ? 'f' : 'r'
  return `${rowIndex}:${resolveRowPresetId(rowIndex) ?? 'none'}:${fontTag}`
}

function scheduleSelectRow(rowIndex, options = {}, onSettled) {
  switchGeneration += 1
  const gen = switchGeneration
  cancelPreload()

  const rows = getRows()
  if (!rows.length) {
    onSettled?.()
    return
  }

  const keepColumn = options.keepColumn ?? false
  const idx = Math.max(0, Math.min(rowIndex, rows.length - 1))
  applyRenderContextForRow(idx)
  selectedRow = idx
  if (!keepColumn) {
    selectedCol = -1
    selectedColumnName = ''
  } else if (selectedColumnName) {
    const cols = ensureSpreadsheet().getColumns?.() ?? []
    const ci = cols.indexOf(selectedColumnName)
    selectedCol = ci >= 0 ? ci : -1
    if (ci < 0) selectedColumnName = ''
  }
  syncRowSelectionUi({ keepColumn })

  void finishSelectRow(idx, gen, options, onSettled)
}

/** 异步渲染预览：缓存命中立即显示；连续切换时旧任务通过 generation + shouldAbort 取消 */
async function finishSelectRow(idx, gen, _options, onSettled) {
  try {
    const cacheKey = rowCacheKey(idx)

    if (rowSvgCache.has(cacheKey)) {
      if (gen === switchGeneration) {
        setPreviewLoadingMessage('')
        showSvgInStage(rowSvgCache.get(cacheKey).cloneNode(true))
        previewDisplayedRow = idx
        schedulePreloadAdjacent(idx, gen)
      }
      return
    }

    setPreviewLoadingMessage(catalogFontsLoaded ? '正在渲染预览…' : '正在渲染预览（字体加载中）…')

    const svgEl = await buildSvgForRow(idx, gen)
    if (gen !== switchGeneration || !svgEl) return

    setPreviewLoadingMessage('')
    rowSvgCache.set(cacheKey, svgEl.cloneNode(true))
    showSvgInStage(svgEl)
    previewDisplayedRow = idx
    schedulePreloadAdjacent(idx, gen)
  } catch (err) {
    if (err?.name === 'AbortError') return
    if (gen === switchGeneration) {
      console.error('页面渲染失败', err)
      setPreviewLoadingMessage('')
    }
  } finally {
    onSettled?.()
  }
}

function scheduleLoadCertificate(id) {
  switchGeneration += 1
  cancelPreload()
  setActiveCertListItem(id)
  const listTitle = catalog.find((c) => c.id === id)?.title
  if (titleEl) titleEl.textContent = listTitle || '加载中…'
  pendingCertId = id
  void runCertLoadQueue()
}

async function runCertLoadQueue() {
  if (certLoadRunner) return
  certLoadRunner = true
  while (pendingCertId != null) {
    const id = pendingCertId
    pendingCertId = null
    try {
      await loadCertificate(id)
    } catch (err) {
      console.error('加载证书失败', err)
    }
  }
  certLoadRunner = false
  if (pendingCertId != null) void runCertLoadQueue()
}

function cancelPreload() {
  if (preloadTimer) {
    clearTimeout(preloadTimer)
    preloadTimer = 0
  }
}

function scrollActivePageIntoView(behavior = 'instant') {
  for (const root of [pageIndexEl, pageIndexDrawerEl]) {
    root?.querySelector('.public-page-jump-btn.is-active')
      ?.scrollIntoView({ block: 'nearest', behavior })
  }
}

/** @returns {boolean} 是否切换了渲染上下文 */
function applyRenderContextForRow(rowIndex) {
  const presetId = resolveRowPresetId(rowIndex)
  if (presetId === activeRenderPresetId) return false

  const bundle = getPresetBundle(presetId)
  if (bundle) {
    if (bundle.template_svg) templateSvg = bundle.template_svg
    if (bundle.page_width_mm && bundle.page_height_mm) {
      pageWidthMm = bundle.page_width_mm
      pageHeightMm = bundle.page_height_mm
      previewViewport.setPageAspectRatio(pageWidthMm, pageHeightMm)
    }
    if (bundle.merged_layout_overrides) {
      currentCert = {
        ...currentCert,
        merged_layout_overrides: bundle.merged_layout_overrides,
      }
    }
    if (bundle.sample_adornments) {
      sampleAdornments = structuredClone(bundle.sample_adornments)
    }
  }
  activeRenderPresetId = presetId
  return true
}

function getActiveSvg() {
  return getStage()?.querySelector('svg') ?? null
}

function syncSvgHighlight() {
  const svg = getActiveSvg()
  if (!svg) return
  setSvgFieldHighlight(svg, selectedColumnName || null, getLayoutOverrides())
}

function focusTableColumn(columnName, { scroll = true } = {}) {
  if (!columnName) return
  const cols = ensureSpreadsheet().getColumns()
  const ci = cols.indexOf(columnName)
  if (ci < 0) return
  selectedCol = ci
  selectedColumnName = columnName
  const sheet = ensureSpreadsheet()
  sheet.syncPageRowSelection?.(selectedRow, ci)
  if (scroll) sheet.scrollToCell(selectedRow, ci, { moveSelection: false })
  syncSvgHighlight()
  renderPublicRowCard()
}

function clearPublicSelection() {
  selectedCol = -1
  selectedColumnName = ''
  ensureSpreadsheet().clearSelection?.()
  ensureSpreadsheet().refreshSelectionVisuals?.()
  syncSvgHighlight()
  renderPublicRowCard()
}

function handlePreviewClick(e) {
  if (e.target.closest('.public-page-nav')) return
  if (previewPointerMoved) return
  if (previewViewport.getPanMode?.()) return
  const svg = getActiveSvg()
  if (!svg) return
  const column = resolveColumnFromPreviewClick(
    svg,
    e.target,
    e.clientX,
    e.clientY,
    getLayoutOverrides(),
  )
  if (!column) {
    clearPublicSelection()
    return
  }
  focusTableColumn(column, { scroll: true })
}

function getRows() {
  return currentCert?.rows?.map((r) => r.row_data) ?? []
}

function getTableColumns() {
  if (tableTemplateColumns?.length) return [...tableTemplateColumns]
  if (columnOrder?.length) return [...columnOrder]
  const rows = getRows()
  if (!rows.length) return []
  const order = []
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!order.includes(k)) order.push(k)
    }
  }
  return order
}

function adornRowForSvg(row) {
  const tableColumns = getTableColumns()
  const layoutOverrides = getLayoutOverrides()
  const debugFn = isPublicAdornDebugEnabled()
    ? (info) => logPublicAdorn('apply', info)
    : null

  const display = applySampleAdornmentsToDisplayRow(
    row,
    tableColumns,
    layoutOverrides,
    sampleAdornments,
    debugFn,
  )

  if (isPublicAdornDebugEnabled()) {
    const diffs = diffAdornRow(row, display, Object.keys(sampleAdornments))
    logPublicAdorn('row-diff', {
      changed: diffs.filter((d) => d.changed),
      unchanged: diffs.filter((d) => !d.changed),
    })
  }

  return display
}

function getSvgRowData(rowIndex) {
  const row = getRows()[rowIndex]
  if (!row) return {}
  return adornRowForSvg(row)
}

function pdfExportOptionsFromApp() {
  return { ttfUrl: fontUrl, fontCatalog, pageWidthMm, pageHeightMm }
}

async function buildSvgForExport(rowIndex) {
  applyRenderContextForRow(rowIndex)
  if (fontCatalog) await warmupCatalogFonts(fontCatalog)
  const cacheKey = rowCacheKey(rowIndex)
  const fromCache = catalogFontsLoaded && rowSvgCache.has(cacheKey)
  logPublicAdorn('buildSvgForExport', {
    rowIndex,
    fromCache,
    displayRow: getSvgRowData(rowIndex),
  })
  if (fromCache) {
    return /** @type {SVGSVGElement} */ (rowSvgCache.get(cacheKey).cloneNode(true))
  }
  return generateSvgFromRow(
    templateSvg,
    getSvgRowData(rowIndex),
    fontUrl,
    getFillOptions({ skipFontInject: false }),
  )
}

function sanitizeFilename(name) {
  return String(name).replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) || 'certificate'
}

function setExportStatus(msg, ms = 3000) {
  if (!exportStatusEl) return
  exportStatusEl.textContent = msg
  if (ms > 0) {
    setTimeout(() => {
      if (exportStatusEl.textContent === msg) exportStatusEl.textContent = ''
    }, ms)
  }
}

/** @type {ReturnType<typeof setTimeout> | null} */
let exportProgressHideTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let exportProgressTimeTimer = null
/** @type {number | null} */
let exportProgressStartAt = null
/** @type {number} */
let exportProgressCurrentPct = 0
/** @type {number} */
let exportProgressTotalPages = 0
/** @type {{ page?: number, total?: number, step?: string, stepId?: string, percent?: number }} */
let exportProgressTimeContext = {}
/** @type {number | null} */
let exportProgressSmoothedMsPerPage = null
/** @type {number} */
let exportProgressLastCompletedPages = 0
/** @type {number | null} */
let exportProgressDisplayRemainingMs = null
/** @type {'pending' | 'loading' | 'done' | 'skipped'} */
let exportFontsStepState = 'pending'
/** @type {Set<string>} */
let exportProgressSkippedSteps = new Set()
/** @type {Record<string, string>} */
let exportProgressStepLabels = {}
let exportProgressPanelOpen = false

const EXPORT_PROGRESS_STEPS = [
  { id: 'init', label: '加载 PDF 组件' },
  { id: 'fonts', label: '预加载字体' },
  { id: 'doc', label: '初始化 PDF 文档' },
  { id: 'pages', label: '逐页生成证书' },
  { id: 'finalize', label: '写入 PDF 文件' },
  { id: 'download', label: '保存到本地' },
]

const EXPORT_PAGE_STEP_LABELS = {
  svg: '生成 SVG',
  prepare: '嵌入图片与字体',
  render: '写入 PDF 矢量',
  done: '本页完成',
}

function resetExportProgressMeta() {
  exportFontsStepState = 'pending'
  exportProgressSkippedSteps = new Set()
  exportProgressStepLabels = {}
}

function formatExportDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec} 秒`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分`
}

function getExportPageStats() {
  const ctx = exportProgressTimeContext
  const total = ctx.total || exportProgressTotalPages || 0
  const page = ctx.page || 0
  const stepId = ctx.stepId

  let completedPages = 0
  if (stepId === 'pages' && page > 0) {
    completedPages = ctx.step === 'done' ? page : Math.max(0, page - 1)
  } else if (stepId === 'finalize' || stepId === 'download') {
    completedPages = total
  }

  return { total, completedPages, stepId }
}

function formatExportPerPage(ms) {
  if (ms < 1000) return '<1 秒/页'
  return `${formatExportDuration(ms)}/页`
}

function updateSmoothedMsPerPage(instantMsPerPage, completedPages) {
  if (instantMsPerPage <= 0 || completedPages <= 0) return

  if (exportProgressSmoothedMsPerPage == null) {
    exportProgressSmoothedMsPerPage = instantMsPerPage
    exportProgressLastCompletedPages = completedPages
    return
  }

  const pagesDelta = completedPages - exportProgressLastCompletedPages
  if (pagesDelta > 0) {
    exportProgressSmoothedMsPerPage =
      exportProgressSmoothedMsPerPage * 0.35 + instantMsPerPage * 0.65
    exportProgressLastCompletedPages = completedPages
  } else if (instantMsPerPage > exportProgressSmoothedMsPerPage) {
    exportProgressSmoothedMsPerPage +=
      (instantMsPerPage - exportProgressSmoothedMsPerPage) * 0.04
  } else {
    exportProgressSmoothedMsPerPage +=
      (instantMsPerPage - exportProgressSmoothedMsPerPage) * 0.18
  }
}

/** 剩余时间 = 平滑后的每页耗时 × 剩余页数 */
function estimateExportRemainingMs(elapsedMs) {
  const { total, completedPages, stepId } = getExportPageStats()
  if (total <= 0 || completedPages <= 0) return null

  updateSmoothedMsPerPage(elapsedMs / completedPages, completedPages)
  const msPerPage = exportProgressSmoothedMsPerPage
  if (!msPerPage) return null

  if (stepId === 'download') return Math.min(msPerPage, 3000)
  if (stepId === 'finalize') return msPerPage
  const remainingPages = total - completedPages
  if (remainingPages <= 0) return 0
  return msPerPage * remainingPages
}

/** 显示用剩余时间：缩短跟得快，延长慢慢调，避免来回闪 */
function getDisplayRemainingMs(rawMs) {
  if (rawMs == null) return null

  if (exportProgressDisplayRemainingMs == null) {
    exportProgressDisplayRemainingMs = rawMs
    return rawMs
  }

  const prev = exportProgressDisplayRemainingMs
  let next = prev

  if (rawMs <= prev) {
    const drop = Math.max(800, (prev - rawMs) * 0.42)
    next = Math.max(rawMs, prev - drop)
    next = next * 0.5 + rawMs * 0.5
  } else {
    const maxRise = Math.max(1200, prev * 0.035)
    next = Math.min(rawMs, prev + maxRise)
    next = next * 0.9 + rawMs * 0.1
  }

  exportProgressDisplayRemainingMs = Math.max(0, next)
  return exportProgressDisplayRemainingMs
}

function formatExportRemaining(ms) {
  if (ms == null) return '计算中…'
  if (ms < 1000) return '不到 1 秒'
  return `约 ${formatExportDuration(ms)}`
}

function buildExportProgressTimeText(elapsedMs) {
  const elapsedStr = formatExportDuration(elapsedMs)
  const { total, completedPages } = getExportPageStats()
  const rawRemaining = estimateExportRemainingMs(elapsedMs)
  const remainingMs = getDisplayRemainingMs(rawRemaining)
  const etaStr = formatExportRemaining(remainingMs)

  if (total > 0) {
    const parts = [`已用时 ${elapsedStr}`, `${completedPages}/${total} 页`]
    if (exportProgressSmoothedMsPerPage) {
      parts.push(`约 ${formatExportPerPage(exportProgressSmoothedMsPerPage)}`)
    }
    parts.push(`预计还需 ${etaStr}`)
    return parts.join(' · ')
  }

  return `已用时 ${elapsedStr} · 预计还需 ${etaStr}`
}

function refreshExportProgressTime(finalLabel) {
  if (!exportProgressTime) return
  if (finalLabel) {
    exportProgressTime.textContent = finalLabel
    return
  }
  if (exportProgressStartAt == null) {
    exportProgressTime.textContent = '已用时 0 秒 · 预计还需 计算中…'
    return
  }
  exportProgressTime.textContent = buildExportProgressTimeText(Date.now() - exportProgressStartAt)
}

function startExportProgressTimer() {
  stopExportProgressTimeTick()
  exportProgressStartAt = Date.now()
  exportProgressCurrentPct = 0
  exportProgressTimeContext = {}
  exportProgressSmoothedMsPerPage = null
  exportProgressLastCompletedPages = 0
  exportProgressDisplayRemainingMs = null
  refreshExportProgressTime()
  exportProgressTimeTimer = setInterval(refreshExportProgressTime, 1000)
}

function stopExportProgressTimeTick() {
  if (exportProgressTimeTimer) {
    clearInterval(exportProgressTimeTimer)
    exportProgressTimeTimer = null
  }
}

function resetExportProgressTimer() {
  stopExportProgressTimeTick()
  exportProgressStartAt = null
  exportProgressCurrentPct = 0
  exportProgressTotalPages = 0
  exportProgressTimeContext = {}
  exportProgressSmoothedMsPerPage = null
  exportProgressLastCompletedPages = 0
  exportProgressDisplayRemainingMs = null
  if (exportProgressTime) {
    exportProgressTime.textContent = '已用时 0 秒 · 预计还需 计算中…'
  }
}

function renderExportProgressSteps() {
  if (!exportProgressSteps) return
  exportProgressSteps.innerHTML = EXPORT_PROGRESS_STEPS.map((step) =>
    `<li class="public-export-step" data-step="${step.id}" data-default-label="${step.label}">${step.label}</li>`,
  ).join('')
}

function mergeExportDoneSteps(doneSteps = []) {
  const merged = [...doneSteps]
  if ((exportFontsStepState === 'done' || exportFontsStepState === 'skipped') && !merged.includes('fonts')) {
    const initIdx = merged.indexOf('init')
    if (initIdx >= 0) merged.splice(initIdx + 1, 0, 'fonts')
    else merged.push('fonts')
  }
  return merged
}

function updateExportProgressSteps(activeId, doneSteps = []) {
  if (!exportProgressSteps) return
  const mergedDone = mergeExportDoneSteps(doneSteps)
  exportProgressSteps.querySelectorAll('.public-export-step').forEach((li) => {
    const id = li.dataset.step
    if (!id) return
    const defaultLabel = li.dataset.defaultLabel || EXPORT_PROGRESS_STEPS.find((s) => s.id === id)?.label || id
    li.classList.toggle('is-done', mergedDone.includes(id))
    li.classList.toggle('is-active', id === activeId && !exportProgressSkippedSteps.has(id))
    li.classList.toggle('is-skipped', exportProgressSkippedSteps.has(id))
    li.textContent = exportProgressStepLabels[id] || defaultLabel
  })
  const pagesLi = exportProgressSteps.querySelector('.public-export-step[data-step="pages"]')
  if (pagesLi && activeId === 'pages' && pagesLi.dataset.pagesLabel) {
    pagesLi.textContent = pagesLi.dataset.pagesLabel
  } else if (pagesLi && !exportProgressStepLabels.pages) {
    pagesLi.textContent = EXPORT_PROGRESS_STEPS.find((s) => s.id === 'pages')?.label || '逐页生成证书'
    delete pagesLi.dataset.pagesLabel
  }
}

function setExportProgressBarAnimating(active) {
  const bar = exportProgressEl?.querySelector('.public-export-progress-bar')
  if (bar) bar.classList.toggle('is-active', !!active)
}

function showExportProgress(visible) {
  if (exportProgressEl) {
    exportProgressEl.hidden = !visible
    exportProgressEl.setAttribute('aria-busy', visible ? 'true' : 'false')
  }
  if (visible) {
    if (!exportProgressPanelOpen) {
      resetExportProgressMeta()
      renderExportProgressSteps()
      startExportProgressTimer()
      exportProgressPanelOpen = true
    }
    setExportProgressBarAnimating(true)
  } else {
    exportProgressPanelOpen = false
    resetExportProgressTimer()
    setExportProgressBarAnimating(false)
  }
}

/**
 * @param {{
 *   title?: string,
 *   message?: string,
 *   percent?: number,
 *   stepId?: string,
 *   doneSteps?: string[],
 *   page?: number,
 *   total?: number,
 *   step?: string,
 *   step?: string,
 *   pageLabel?: string,
 *   skippedSteps?: string[],
 *   stepLabels?: Record<string, string>,
 * }} opts
 */
function setExportProgress(opts = {}) {
  if (exportProgressHideTimer) {
    clearTimeout(exportProgressHideTimer)
    exportProgressHideTimer = null
  }
  showExportProgress(true)
  if (opts.skippedSteps?.length) {
    for (const id of opts.skippedSteps) exportProgressSkippedSteps.add(id)
  }
  if (opts.stepLabels) {
    Object.assign(exportProgressStepLabels, opts.stepLabels)
  }
  const pct = Math.min(100, Math.max(0, Math.round(opts.percent ?? 0)))
  exportProgressCurrentPct = pct
  exportProgressTimeContext = {
    page: opts.page,
    total: opts.total || exportProgressTotalPages || undefined,
    step: opts.step,
    stepId: opts.stepId,
    percent: pct,
  }
  refreshExportProgressTime()
  if (exportProgressTitle && opts.title) exportProgressTitle.textContent = opts.title
  if (exportProgressPct) exportProgressPct.textContent = `${pct}%`
  if (exportProgressDetail) exportProgressDetail.textContent = opts.message || ''
  if (exportProgressFill) exportProgressFill.style.width = `${pct}%`
  if (exportStatusEl && opts.message) exportStatusEl.textContent = opts.message

  if (opts.stepId) {
    updateExportProgressSteps(opts.stepId, opts.doneSteps || [])
    const pagesLi = exportProgressSteps?.querySelector('.public-export-step[data-step="pages"]')
    if (pagesLi && opts.stepId === 'pages' && opts.page && opts.total) {
      pagesLi.dataset.pagesLabel = `逐页生成（${opts.page}/${opts.total}）`
      pagesLi.textContent = pagesLi.dataset.pagesLabel
    }
  }

  if (exportProgressPage) {
    const parts = []
    if (opts.page && opts.total) parts.push(`当前页 ${opts.page} / ${opts.total}`)
    if (opts.step && EXPORT_PAGE_STEP_LABELS[opts.step]) {
      parts.push(`步骤：${EXPORT_PAGE_STEP_LABELS[opts.step]}`)
    }
    if (opts.pageLabel) parts.push(opts.pageLabel)
    if (parts.length) {
      exportProgressPage.textContent = parts.join(' · ')
      exportProgressPage.hidden = false
    } else {
      exportProgressPage.textContent = ''
      exportProgressPage.hidden = true
    }
  }
}

function applyPdfExportProgress(info) {
  const payload = typeof info === 'object' && info !== null
    ? info
    : { detail: String(info ?? ''), percent: 0 }

  let pageLabel = ''
  if (payload.page) {
    const label = getPageNavRowLabel(payload.page - 1)
    if (label) pageLabel = `标识：${label}`
  }

  setExportProgress({
    title: payload.phase === 'done' ? '导出完成' : '正在导出全部 PDF',
    message: payload.detail || '',
    percent: payload.percent,
    stepId: payload.stepId,
    doneSteps: mergeExportDoneSteps(payload.doneSteps || []),
    page: payload.page,
    total: payload.total,
    step: payload.step,
    pageLabel,
  })
  if (payload.phase === 'done') {
    setExportProgressBarAnimating(false)
    stopExportProgressTimeTick()
    if (exportProgressStartAt != null) {
      refreshExportProgressTime(`总耗时 ${formatExportDuration(Date.now() - exportProgressStartAt)}`)
    }
  }
}

function hideExportProgress(delayMs = 0) {
  if (exportProgressHideTimer) clearTimeout(exportProgressHideTimer)
  const hide = () => {
    exportProgressPanelOpen = false
    showExportProgress(false)
    if (exportProgressFill) exportProgressFill.style.width = '0%'
    if (exportProgressPct) exportProgressPct.textContent = '0%'
    if (exportProgressPage) {
      exportProgressPage.textContent = ''
      exportProgressPage.hidden = true
    }
    resetExportProgressTimer()
    exportProgressHideTimer = null
  }
  if (delayMs > 0) exportProgressHideTimer = setTimeout(hide, delayMs)
  else hide()
}

function setExportControlsDisabled(disabled) {
  for (const btn of [btnExportSvg, btnExportPdf, btnExportBatch]) {
    if (btn) btn.disabled = disabled || !getRows().length
  }
}

function updateExportButtons() {
  const hasRows = getRows().length > 0
  for (const btn of [btnExportSvg, btnExportPdf, btnExportBatch]) {
    if (btn) btn.disabled = !hasRows
  }
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

function getStage() {
  return previewArea.querySelector('.preview-stage')
}

function mountStageWithSvg(svgEl) {
  const stage = document.createElement('div')
  stage.className = 'preview-stage'
  stage.appendChild(svgEl)
  previewViewport.setContent(stage)
}

function getPageNavColumnsForRow(rowIndex) {
  const presetId = resolveRowPresetId(rowIndex)
  const bundle = getPresetBundle(presetId)
  return parsePageNavColumns(bundle?.page_nav_column)
}

function buildPageNavMetaHtml(rowIndex) {
  const cols = getPageNavColumnsForRow(rowIndex)
  if (!cols.length) return ''
  const row = getRows()[rowIndex]
  const values = getPageNavRowValues(row, cols)
  if (!values.length) return ''
  if (values.length === 1) {
    return `<span class="public-page-jump-meta">${escapeHtml(values[0])}</span>`
  }
  return (
    `<span class="public-page-jump-meta public-page-jump-meta--multi">${
      values.map((val) => `<span class="public-page-jump-meta-line">${escapeHtml(val)}</span>`).join('')
    }</span>`
  )
}

function getPageNavRowLabel(rowIndex) {
  const cols = getPageNavColumnsForRow(rowIndex)
  if (!cols.length) return ''
  const row = getRows()[rowIndex]
  if (!row) return ''
  return getPageNavRowValues(row, cols).join(' · ')
}

function buildPageIndexHtml(total) {
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1
    const active = i === selectedRow ? ' is-active' : ''
    const current = i === selectedRow ? ' aria-current="page"' : ''
    const label = getPageNavRowLabel(i)
    const metaHtml = buildPageNavMetaHtml(i)
    const aria = label ? `第 ${n} 页，${label}` : `第 ${n} 页`
    return `<button type="button" class="public-page-jump-btn${active}" data-page="${i}" aria-label="${escapeHtml(aria)}"${current}><span class="public-page-jump-preview" aria-hidden="true"><span class="public-page-jump-num">${n}</span>${metaHtml}</span></button>`
  }).join('')
}

function syncPageIndexJumpButtons(total) {
  for (const root of [pageIndexEl, pageIndexDrawerEl]) {
    if (!root) continue
    const buttons = root.querySelectorAll('.public-page-jump-btn')
    if (buttons.length !== total) continue
    buttons.forEach((btn) => {
      const page = Number(btn.dataset.page)
      const active = page === selectedRow
      btn.classList.toggle('is-active', active)
      if (active) btn.setAttribute('aria-current', 'page')
      else btn.removeAttribute('aria-current')
    })
  }
}

function updateMobilePageSummary(total) {
  const current = total > 0 ? selectedRow + 1 : null
  if (pageCurrentEl) pageCurrentEl.textContent = current != null ? String(current) : '-'
  if (pageTotalEl) pageTotalEl.textContent = total > 0 ? String(total) : '-'
  if (pagesToggle) {
    pagesToggle.textContent = current != null ? `${current}/${total}` : '页码'
    pagesToggle.disabled = total === 0
  }
}

function clearPageIndexTargets() {
  const empty = '- / -'
  if (pageIndexEl) {
    pageIndexEl.textContent = empty
    pageIndexEl.classList.remove('public-page-nav-index--jump')
  }
  if (pageIndexDrawerEl) {
    pageIndexDrawerEl.textContent = empty
    pageIndexDrawerEl.classList.remove('public-page-nav-index--jump')
  }
  updateMobilePageSummary(0)
}

function updatePagination() {
  const rows = getRows()
  const total = rows.length
  if (!pageIndexEl || !prevBtn || !nextBtn) return

  if (total === 0) {
    if (pageNavEl) pageNavEl.hidden = true
    if (pageNavResizeEl) pageNavResizeEl.hidden = true
    clearPageIndexTargets()
    prevBtn.disabled = true
    nextBtn.disabled = true
    return
  }

  if (pageNavEl) pageNavEl.hidden = false
  if (pageNavResizeEl) pageNavResizeEl.hidden = false
  selectedRow = Math.max(0, Math.min(selectedRow, total - 1))

  const html = buildPageIndexHtml(total)
  pageIndexEl.classList.add('public-page-nav-index--jump')
  pageIndexEl.innerHTML = html
  if (pageIndexDrawerEl) {
    pageIndexDrawerEl.classList.add('public-page-nav-index--jump')
    pageIndexDrawerEl.innerHTML = html
  }

  prevBtn.disabled = selectedRow <= 0
  nextBtn.disabled = selectedRow >= total - 1
  updateMobilePageSummary(total)

  requestAnimationFrame(() => {
    scrollActivePageIntoView('instant')
  })
}

function updatePaginationSelection() {
  const rows = getRows()
  const total = rows.length
  if (!pageIndexEl || !prevBtn || !nextBtn || total === 0) return

  selectedRow = Math.max(0, Math.min(selectedRow, total - 1))
  prevBtn.disabled = selectedRow <= 0
  nextBtn.disabled = selectedRow >= total - 1
  updateMobilePageSummary(total)

  const sidebarButtons = pageIndexEl.querySelectorAll('.public-page-jump-btn')
  if (sidebarButtons.length !== total) {
    updatePagination()
    return
  }

  syncPageIndexJumpButtons(total)

  requestAnimationFrame(() => {
    scrollActivePageIntoView('instant')
  })
}

/** @type {number} */
let syncRowCardRaf = 0

function syncRowSelectionUi({ keepColumn = false } = {}) {
  updatePaginationSelection()
  ensureSpreadsheet().syncPageRowSelection?.(
    selectedRow,
    keepColumn && selectedCol >= 0 ? selectedCol : -1,
  )
  ensureSpreadsheet().refreshSelectionVisuals?.()
  updateExportButtons()
  scrollPublicTableToSelectedRow()
  if (syncRowCardRaf) cancelAnimationFrame(syncRowCardRaf)
  syncRowCardRaf = requestAnimationFrame(() => {
    syncRowCardRaf = 0
    renderPublicRowCard()
  })
}

function scrollPublicTableToSelectedRow() {
  if (!isPublicMobileLandscapeLayout()) return
  if (publicContent?.classList.contains('public-view-both')) return
  const rows = getRows()
  if (!rows.length) return
  const sheet = ensureSpreadsheet()
  const ci = selectedCol >= 0 ? selectedCol : 0
  sheet.scrollToCell?.(selectedRow, ci, { moveSelection: false })
}

function shouldShowPublicRowCard() {
  return isPublicMobileLandscapeLayout()
    && !!currentCert?.rows?.length
    && publicContent?.classList.contains('public-view-both')
}

function applyPublicHeadPlacement() {
  if (!mainHeadEl || !previewPanelEl || !previewSideEl) return
  const toSide = shouldShowPublicRowCard()
  const target = toSide ? previewSideEl : previewPanelEl
  if (mainHeadEl.parentElement !== target) {
    target.insertBefore(mainHeadEl, target.firstChild)
  }
  previewSideEl.classList.toggle('public-preview-side--active', toSide)
}

function shouldAllowPublicPreviewFullscreen() {
  return isPublicMobileLandscapeLayout()
    && !!currentCert
    && publicContent?.classList.contains('public-view-both')
}

function setPublicPreviewFullscreen(on) {
  const enable = !!on && shouldAllowPublicPreviewFullscreen()
  const wasOn = document.body.classList.contains('public-preview-fullscreen')
  document.body.classList.toggle('public-preview-fullscreen', enable)
  btnPreviewFullscreen?.classList.toggle('active', enable)
  btnPreviewFullscreen?.setAttribute('aria-pressed', enable ? 'true' : 'false')
  if (btnPreviewFullscreen) {
    btnPreviewFullscreen.textContent = enable ? '退出' : '全屏'
    btnPreviewFullscreen.title = enable ? '退出预览全屏' : '预览全屏'
  }
  if (btnPreviewFullscreenExit) btnPreviewFullscreenExit.hidden = !enable
  if (enable) {
    closePublicMenu()
    closePublicSettings()
    closePublicPages()
  }
  if (enable !== wasOn) {
    requestAnimationFrame(() => previewViewport.scheduleFitView?.())
  }
}

function applyPublicPreviewFullscreenState() {
  if (!shouldAllowPublicPreviewFullscreen()) {
    setPublicPreviewFullscreen(false)
  }
}

function renderPublicRowCard() {
  if (!rowCardEl) return
  const show = shouldShowPublicRowCard()
  applyPublicHeadPlacement()
  applyPublicPreviewFullscreenState()
  rowCardEl.hidden = !show
  if (!show) return

  const rows = getRows()
  const total = rows.length
  if (!total) {
    rowCardEl.hidden = true
    return
  }

  const rowIndex = Math.max(0, Math.min(selectedRow, total - 1))
  const rawRow = rows[rowIndex] || {}
  const columns = getTableColumns()
  const keys = columns.length ? columns : Object.keys(rawRow)

  if (rowCardPageEl) rowCardPageEl.textContent = `第 ${rowIndex + 1} / ${total} 页`
  const presetLabel = layoutPresetLabelForRow(rowIndex)
  if (rowCardPresetEl) {
    rowCardPresetEl.textContent = presetLabel || ''
    rowCardPresetEl.hidden = !presetLabel
  }

  if (!rowCardFieldsEl) return

  const items = []
  for (const col of keys) {
    const val = rawRow[col]
    if (val == null || String(val).trim() === '') continue
    const displayVal = String(val).trim()
    items.push(
      `<button type="button" class="public-row-card-item${selectedColumnName === col ? ' is-active' : ''}" data-column="${escapeAttr(col)}" role="listitem">`
      + `<span class="public-row-card-label">${escapeHtml(col)}</span>`
      + `<span class="public-row-card-value">${escapeHtml(displayVal)}</span>`
      + '</button>',
    )
  }

  rowCardFieldsEl.innerHTML = items.length
    ? items.join('')
    : '<p class="public-row-card-empty">本页无表格数据</p>'
}

function showSvgInStage(svgEl) {
  const stage = getStage()
  if (stage) {
    destroyLayoutEditor()
    stage.replaceChildren(svgEl)
  } else {
    mountStageWithSvg(svgEl)
  }
  requestAnimationFrame(() => {
    attachLayoutEditorToStage()
    syncSvgHighlight()
  })
}

function ensureSpreadsheet() {
  if (spreadsheet) return spreadsheet
  spreadsheet = mountSpreadsheetTable(tableWrap, {
    readOnly: true,
    getData: getRows,
    getColumns: getTableColumns,
    setData: () => {},
    getSelectedRow: () => selectedRow,
    setSelectedRow: (i) => { selectedRow = i },
    getPreviewDisplayedRow: () => previewDisplayedRow,
    getSelectedCol: () => selectedCol,
    setSelectedCol: (i) => { selectedCol = i },
    onRowSelect: (ri) => {
      scheduleSelectRow(ri, { keepColumn: true })
    },
    onSelectionClear: () => {
      selectedCol = -1
      selectedColumnName = ''
      syncSvgHighlight()
      ensureSpreadsheet().refreshSelectionVisuals?.()
    },
    onCellSelect: (ri, colName, ci) => {
      selectedCol = ci
      selectedColumnName = colName
      syncSvgHighlight()
    },
    getTrailingColumns: () => (
      currentCert ? [{ id: 'layout-preset', label: '布局模式', width: 108 }] : []
    ),
    renderTrailingColHead: (metaCol) => (
      `<span class="spreadsheet-col-head-label">${escapeHtml(metaCol.label)}</span>`
    ),
    renderTrailingCell: (rowIndex) => (
      `<span class="spreadsheet-layout-preset-label" title="${escapeHtml(layoutPresetLabelForRow(rowIndex))}">${escapeHtml(layoutPresetLabelForRow(rowIndex))}</span>`
    ),
  })
  return spreadsheet
}

function renderTable() {
  ensureSpreadsheet().render()
  updatePagination()
  updateExportButtons()
  renderPublicRowCard()
}

async function buildSvgForRow(rowIndex, switchGen) {
  if (switchGen != null && switchGen !== switchGeneration) return null
  applyRenderContextForRow(rowIndex)
  const rawRow = getRows()[rowIndex]
  const displayRow = getSvgRowData(rowIndex)

  groupPublicAdorn(`buildSvg row ${rowIndex + 1}`, () => {
    logPublicAdorn('raw-row', rawRow)
    logPublicAdorn('display-row', displayRow)
    logPublicAdorn('context', {
      tableColumns: getTableColumns(),
      adornmentKeys: Object.keys(sampleAdornments),
      sampleAdornments,
      layoutOverrideKeys: Object.keys(getLayoutOverrides()),
      presetId: currentCert?.preset_id ?? null,
      hasPublicSnapshot: !!currentCert?.preview_ui?.public_snapshot,
    })
  })

  if (switchGen != null && switchGen !== switchGeneration) return null

  const opts = getFillOptions({
    shouldAbort: () => switchGen != null && switchGen !== switchGeneration,
  })
  let svgEl
  try {
    svgEl = await generateSvgFromRow(templateSvg, displayRow, fontUrl, opts)
  } catch (err) {
    if (err?.name === 'AbortError') return null
    throw err
  }
  if (switchGen != null && switchGen !== switchGeneration) return null
  if (!opts.skipFontInject) {
    previewFontReady = true
  }

  const dataTexts = readSvgDataLayerTexts(svgEl)
  if (isPublicAdornDebugEnabled()) {
    logPublicAdorn('svg-data-layer', dataTexts)
  }
  if (dataTexts.length === 0) {
    warnPublicAdorn('svg-data-layer-empty', {
      rowIndex,
      displayRow,
      hint: '未写入 #cat-data-layer，可能 layout 无编辑框或列值为空',
    })
  } else {
    for (const { column, text } of dataTexts) {
      if (!shouldWarnSvgMissingAdorn(column, rawRow, displayRow, text, sampleAdornments)) continue
      warnPublicAdorn('svg-missing-adorn', {
        column,
        raw: String(rawRow?.[column] ?? ''),
        expected: String(displayRow?.[column] ?? ''),
        svgText: text,
        hint: '该列配置了前后缀，但 SVG 仍显示表格原值',
      })
    }
  }

  return svgEl
}

function schedulePreloadAdjacent(center, gen) {
  if (preloadTimer) clearTimeout(preloadTimer)
  preloadTimer = setTimeout(() => {
    preloadTimer = 0
    if (gen !== switchGeneration) return
    preloadAdjacentRows(center, gen)
  }, 450)
}

function preloadAdjacentRows(center, gen) {
  const rows = getRows()
  for (const i of [center - 1, center + 1]) {
    if (gen !== switchGeneration) return
    const key = rowCacheKey(i)
    if (i < 0 || i >= rows.length || rowSvgCache.has(key)) continue
    void buildSvgForRow(i, gen).then((svg) => {
      if (!svg || gen !== switchGeneration) return
      rowSvgCache.set(key, svg.cloneNode(true))
    }).catch((err) => {
      if (err?.name !== 'AbortError') { /* 预加载失败可忽略 */ }
    })
  }
}

function hasNonEmptyAdornments(adornments) {
  return adornments && typeof adornments === 'object' && Object.keys(adornments).length > 0
}

/** 证书元数据里是否曾记录过前后缀（说明 API 可能漏传，而非从未配置） */
function certificateHintsMissingAdornments(certificate) {
  const snap = certificate?.preview_ui?.public_snapshot
  if (hasNonEmptyAdornments(snap?.sample_adornments)) return true
  const bundles = certificate?.preset_bundles
  if (!bundles || typeof bundles !== 'object') return false
  return Object.values(bundles).some((bundle) => hasNonEmptyAdornments(bundle?.sample_adornments))
}

function pickPublicRenderFields(certificate) {
  const snap = certificate?.preview_ui?.public_snapshot
  const linkedPreset = !!certificate?.preset_id

  let sampleAdornments = {}
  if (hasNonEmptyAdornments(certificate?.sample_adornments)) {
    sampleAdornments = structuredClone(certificate.sample_adornments)
  } else if (linkedPreset) {
    const bundle = certificate?.preset_bundles?.[String(certificate.preset_id)]
    if (hasNonEmptyAdornments(bundle?.sample_adornments)) {
      sampleAdornments = structuredClone(bundle.sample_adornments)
    }
  } else if (hasNonEmptyAdornments(snap?.sample_adornments)) {
    sampleAdornments = structuredClone(snap.sample_adornments)
  }

  const mergedLayout = certificate?.merged_layout_overrides
    || (!linkedPreset ? snap?.merged_layout_overrides : null)
    || certificate?.layout_overrides
    || {}

  const tableTemplateColumns = Array.isArray(certificate?.table_template_columns) && certificate.table_template_columns.length
    ? [...certificate.table_template_columns]
    : !linkedPreset && Array.isArray(snap?.table_template_columns) && snap.table_template_columns.length
      ? [...snap.table_template_columns]
      : null

  return { sampleAdornments, mergedLayout, tableTemplateColumns }
}

async function ensurePublicRenderFields(id, certificate) {
  let fields = pickPublicRenderFields(certificate)
  if (hasNonEmptyAdornments(fields.sampleAdornments) || !certificate?.preset_id) {
    return fields
  }

  try {
    const { snapshot } = await api.getPublicCertificateRenderSnapshot(id)
    if (snapshot && typeof snapshot === 'object') {
      fields = {
        sampleAdornments: hasNonEmptyAdornments(snapshot.sample_adornments)
          ? structuredClone(snapshot.sample_adornments)
          : fields.sampleAdornments,
        mergedLayout: snapshot.merged_layout_overrides || fields.mergedLayout,
        tableTemplateColumns: Array.isArray(snapshot.table_template_columns) && snapshot.table_template_columns.length
          ? [...snapshot.table_template_columns]
          : fields.tableTemplateColumns,
      }
      logPublicAdorn('render-snapshot-fallback', {
        adornmentKeys: Object.keys(fields.sampleAdornments),
        source: 'GET /api/public/certificates/:id/render-snapshot',
      })
    }
  } catch (err) {
    warnPublicAdorn('render-snapshot-failed', {
      preset_id: certificate.preset_id,
      error: err?.message || String(err),
      hint: '3003 端口可能是旧版 API。请 Ctrl+C 后重新运行 npm run dev:local',
    })
  }

  return fields
}

/** @type {Map<number, object>} */
const publicCertDataCache = new Map()

function setActiveCertListItem(id) {
  listEl?.querySelectorAll('.public-cert-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.id) === id)
  })
  scrollActiveCertIntoView()
}

/** 竖屏窄屏，或触屏手机横屏（宽度超 768 但视口较矮） */
const PUBLIC_MOBILE_LAYOUT_QUERY =
  '(max-width: 768px), (max-width: 1024px) and (max-height: 520px) and (hover: none) and (pointer: coarse)'

const PUBLIC_MOBILE_LANDSCAPE_QUERY =
  '(max-width: 1024px) and (max-height: 520px) and (hover: none) and (pointer: coarse)'

const PUBLIC_MOBILE_MQ = window.matchMedia(PUBLIC_MOBILE_LAYOUT_QUERY)
const PUBLIC_MOBILE_LANDSCAPE_MQ = window.matchMedia(PUBLIC_MOBILE_LANDSCAPE_QUERY)

function isPublicMobileLayout() {
  return PUBLIC_MOBILE_MQ.matches
}

function isPublicMobileLandscapeLayout() {
  return isPublicMobileLayout() && PUBLIC_MOBILE_LANDSCAPE_MQ.matches
}

function scrollActiveCertIntoView() {
  if (!isPublicMobileLayout()) return
  listEl?.querySelector('.public-cert-btn.active')?.scrollIntoView({
    inline: 'nearest',
    block: 'nearest',
    behavior: 'smooth',
  })
}

function setPublicMenuOpen(open) {
  document.body.classList.toggle('public-menu-open', open)
  menuToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (menuBackdrop) menuBackdrop.hidden = !open
  if (open) {
    closePublicSettings()
    closePublicPages()
  }
}

function closePublicMenu() {
  setPublicMenuOpen(false)
}

function setPublicSettingsOpen(open) {
  if (!isPublicMobileLayout()) {
    closePublicSettings()
    return
  }
  document.body.classList.toggle('public-settings-open', open)
  settingsToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  settingsDrawer?.setAttribute('aria-hidden', open ? 'false' : 'true')
  if (settingsBackdrop) settingsBackdrop.hidden = !open
  if (open) {
    closePublicMenu()
    closePublicPages()
  }
}

function closePublicSettings() {
  document.body.classList.remove('public-settings-open')
  settingsToggle?.setAttribute('aria-expanded', 'false')
  settingsDrawer?.setAttribute('aria-hidden', 'true')
  if (settingsBackdrop) settingsBackdrop.hidden = true
}

function setPublicPagesOpen(open) {
  if (!isPublicMobileLayout()) {
    closePublicPages()
    return
  }
  document.body.classList.toggle('public-pages-open', open)
  pagesToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  pagesDrawer?.setAttribute('aria-hidden', open ? 'false' : 'true')
  if (pagesBackdrop) pagesBackdrop.hidden = !open
  if (open) {
    closePublicMenu()
    closePublicSettings()
    requestAnimationFrame(() => scrollActivePageIntoView('instant'))
  }
}

function closePublicPages() {
  document.body.classList.remove('public-pages-open')
  pagesToggle?.setAttribute('aria-expanded', 'false')
  pagesDrawer?.setAttribute('aria-hidden', 'true')
  if (pagesBackdrop) pagesBackdrop.hidden = true
}

menuToggle?.addEventListener('click', () => {
  setPublicMenuOpen(!document.body.classList.contains('public-menu-open'))
})
menuBackdrop?.addEventListener('click', closePublicMenu)

settingsToggle?.addEventListener('click', () => {
  setPublicSettingsOpen(!document.body.classList.contains('public-settings-open'))
})
settingsClose?.addEventListener('click', closePublicSettings)
settingsBackdrop?.addEventListener('click', closePublicSettings)

pagesToggle?.addEventListener('click', () => {
  setPublicPagesOpen(!document.body.classList.contains('public-pages-open'))
})
pagesClose?.addEventListener('click', closePublicPages)
pagesBackdrop?.addEventListener('click', closePublicPages)

function handlePageJumpClick(e) {
  const btn = e.target.closest('.public-page-jump-btn')
  if (!btn || btn.disabled) return
  e.stopPropagation()
  const page = Number(btn.dataset.page)
  if (!Number.isFinite(page) || page === selectedRow) return
  scheduleSelectRow(page)
}

function applyPublicResponsiveLayout() {
  const mobile = isPublicMobileLayout()
  const landscape = isPublicMobileLandscapeLayout()
  document.body.classList.toggle('public-layout-mobile', mobile)
  document.body.classList.toggle('public-layout-mobile-landscape', landscape)
  if (!mobile) {
    closePublicMenu()
    closePublicSettings()
    closePublicPages()
  } else if (landscape) {
    closePublicMenu()
  }
  applyPublicHeadPlacement()
  applyPublicPreviewFullscreenState()
  renderPublicRowCard()
  if (mobile && publicContent?.classList.contains('public-view-both')) {
    requestAnimationFrame(() => {
      if (!landscape) restoreTableSplit()
      previewViewport.scheduleFitView?.()
      scrollPublicTableToSelectedRow()
    })
  }
}

function resetPublicViewerToSelectPrompt(message) {
  const cfg = getSiteConfig()
  const prompt = message ?? siteText('selectEntity', cfg)
  currentCert = null
  selectedRow = 0
  selectedCol = -1
  selectedColumnName = ''
  activeRenderPresetId = null
  presetBundles = {}
  templateSvg = EMPTY_SVG_TEMPLATE
  tableTemplateColumns = null
  sampleAdornments = {}
  columnOrder = null
  previewDisplayedRow = -1
  rowSvgCache.clear()
  destroyLayoutEditor()

  if (titleEl) titleEl.textContent = siteText('selectEntity', cfg)
  setPreviewLoadingMessage('')
  previewViewport.setContent(Object.assign(document.createElement('p'), {
    className: 'public-empty',
    textContent: prompt,
  }))
  renderTable()
  applyPublicPreviewFullscreenState()
}

function applyCertificateState(certificate, renderFields) {
  currentCert = {
    ...certificate,
    merged_layout_overrides: renderFields.mergedLayout,
  }
  setTrackingCert(currentCert)
  presetBundles = certificate.preset_bundles
    || certificate.preview_ui?.public_snapshot?.preset_bundles
    || {}
  activeRenderPresetId = null
  templateSvg = certificate.template_svg || EMPTY_SVG_TEMPLATE
  const pageSize = normalizePageSizeMm(certificate.page_width_mm, certificate.page_height_mm)
  pageWidthMm = pageSize.pageWidthMm
  pageHeightMm = pageSize.pageHeightMm
  previewViewport.setPageAspectRatio(pageWidthMm, pageHeightMm)
  tableTemplateColumns = renderFields.tableTemplateColumns
  sampleAdornments = renderFields.sampleAdornments
  columnOrder = Array.isArray(certificate.column_order) && certificate.column_order.length
    ? [...certificate.column_order]
    : null
}

function schedulePreviewFitAfterSwitch(gen) {
  if (!previewFitPending) return
  requestAnimationFrame(() => {
    if (gen !== loadGeneration) return
    previewViewport.fitView()
    previewFitPending = false
  })
}

async function enrichPublicRenderFields(id, certificate, gen) {
  if (gen !== loadGeneration) return
  const needsFetch = !hasNonEmptyAdornments(pickPublicRenderFields(certificate).sampleAdornments)
    && !!certificate?.preset_id
  if (!needsFetch) return

  const fields = await ensurePublicRenderFields(id, certificate)
  if (gen !== loadGeneration) return

  if (!hasNonEmptyAdornments(fields.sampleAdornments)) {
    if (certificateHintsMissingAdornments(certificate)) {
      warnPublicAdornCritical('no-adornments-from-api', {
        preset_id: certificate.preset_id,
        hint: '后台补拉 render-snapshot 仍无 sample_adornments。请重新发布证书，或 Ctrl+C 后重启 npm run dev:local',
      })
    } else {
      logPublicAdorn('no-adornments-configured', {
        preset_id: certificate.preset_id,
        hint: '布局预设 preview_sample_row 中无 __adorn__ 前后缀。请在「布局模板」中为各列设置前后缀并保存',
      })
    }
    return
  }

  const changed = JSON.stringify(sampleAdornments) !== JSON.stringify(fields.sampleAdornments)
    || JSON.stringify(getLayoutOverrides()) !== JSON.stringify(fields.mergedLayout)
  if (!changed) return

  sampleAdornments = fields.sampleAdornments
  tableTemplateColumns = fields.tableTemplateColumns ?? tableTemplateColumns
  currentCert = {
    ...currentCert,
    merged_layout_overrides: fields.mergedLayout,
  }
  publicCertDataCache.set(id, {
    ...certificate,
    sample_adornments: fields.sampleAdornments,
    merged_layout_overrides: fields.mergedLayout,
    table_template_columns: fields.tableTemplateColumns ?? certificate.table_template_columns,
  })
  previewDisplayedRow = -1
  rowSvgCache.clear()
  previewFontReady = catalogFontsLoaded
  renderTable()
  scheduleSelectRow(selectedRow, { keepColumn: true })
  schedulePreviewFitAfterSwitch(gen)
}

async function loadCertificate(id) {
  const gen = ++loadGeneration
  switchGeneration += 1
  cancelPreload()

  setActiveCertListItem(id)
  const listTitle = catalog.find((c) => c.id === id)?.title
  if (titleEl) titleEl.textContent = listTitle || '加载中…'
  setPreviewLoadingMessage('正在加载证书…')

  let certificate = publicCertDataCache.get(id)
  if (!certificate) {
    try {
      const res = await api.getPublicCertificate(id)
      certificate = res.certificate
      if (certificate) publicCertDataCache.set(id, certificate)
    } catch (err) {
      console.error(err)
      if (gen === loadGeneration) {
        setPreviewLoadingMessage('')
        if (titleEl) titleEl.textContent = '加载失败'
      }
      return
    }
  }
  if (gen !== loadGeneration || !certificate) return

  const listItem = catalog.find((c) => c.id === id)
  const groupId = certificate.group_id ?? listItem?.group_id ?? null
  const cfg = await loadSiteConfigForGroup(groupId)
  setSiteConfig(cfg)
  applyPublicPageBranding(cfg)
  const nextPath = buildPublicCertLocationUrl(
    { id, publicSlug: certificate.public_slug ?? null },
    cfg,
  )
  if (nextPath) window.history.replaceState({}, '', nextPath)

  updateCatalogTableSearchText(id, certificate)

  const renderFields = pickPublicRenderFields(certificate)
  applyCertificateState(certificate, renderFields)

  groupPublicAdorn(`loadCertificate #${id}`, () => {
    logPublicAdorn('api-certificate', {
      id: certificate.id,
      title: certificate.title,
      preset_id: certificate.preset_id ?? null,
      table_template_id: certificate.table_template_id ?? null,
      column_order: certificate.column_order,
      table_template_columns: certificate.table_template_columns,
      sample_adornment_keys: Object.keys(sampleAdornments),
      sample_adornments: sampleAdornments,
      merged_layout_keys: Object.keys(certificate.merged_layout_overrides || {}),
      cert_layout_keys: Object.keys(certificate.layout_overrides || {}),
      public_snapshot: certificate.preview_ui?.public_snapshot ?? null,
      first_row_keys: certificate.rows?.[0]?.row_data ? Object.keys(certificate.rows[0].row_data) : [],
    })
  })

  selectedRow = 0
  selectedCol = -1
  selectedColumnName = ''
  previewDisplayedRow = -1
  previewFontReady = catalogFontsLoaded
  rowSvgCache.clear()
  destroyLayoutEditor()

  titleEl.textContent = certificate.title

  if (!certificate.rows?.length) {
    renderTable()
    setPreviewLoadingMessage('')
    const empty = document.createElement('p')
    empty.className = 'public-empty'
    empty.textContent = siteText('noEntityRows', cfg)
    previewViewport.setContent(empty)
    return
  }

  previewFitPending = true
  renderTable()

  scheduleSelectRow(0, { keepColumn: false }, () => {
    if (gen !== loadGeneration) return
    schedulePreviewFitAfterSwitch(gen)
  })

  void enrichPublicRenderFields(id, certificate, gen)
}

function certTableSearchBlob(cert) {
  return cert.table_search_text || cert._table_search_text || ''
}

function filteredCatalog() {
  if (!normalizeSearchText(certSearch)) return catalog
  return catalog.filter((c) => searchTextIncludes(certTableSearchBlob(c), certSearch))
}

function updateCatalogTableSearchText(certId, certificate) {
  const rows = certificate?.rows
  if (!rows?.length) return
  const idx = catalog.findIndex((c) => c.id === certId)
  if (idx < 0) return
  catalog[idx]._table_search_text = buildCertificateTableSearchText(rows.map((r) => r.row_data))
  if (certSearch.trim()) renderPublicCertList()
}

async function ensureCatalogTableSearchText() {
  const missing = catalog.filter((c) => !c.table_search_text && !c._table_search_text)
  if (!missing.length) return
  await Promise.all(missing.map(async (item) => {
    const cached = publicCertDataCache.get(item.id)
    if (cached?.rows?.length) {
      item._table_search_text = buildCertificateTableSearchText(cached.rows.map((r) => r.row_data))
      return
    }
    try {
      const { certificate } = await api.getPublicCertificate(item.id)
      if (certificate) {
        publicCertDataCache.set(item.id, certificate)
        if (certificate.rows?.length) {
          item._table_search_text = buildCertificateTableSearchText(certificate.rows.map((r) => r.row_data))
        }
      }
    } catch {
      // 单张证书失败不影响其余
    }
  }))
}

function formatSearchResultCount(count) {
  return count >= 100 ? '99+' : String(count)
}

function updatePublicSearchSummary(listCount) {
  if (!certSearchSummary) return
  const q = certSearch.trim()
  if (!q) {
    certSearchSummary.hidden = true
    certSearchSummary.textContent = ''
    return
  }
  const label = formatSearchResultCount(listCount)
  certSearchSummary.hidden = false
  certSearchSummary.textContent = `以下共 ${label} ${siteText('matchEntitiesSummary', getSiteConfig())}`
}

function renderPublicCertList() {
  if (!listEl) return
  const list = filteredCatalog()
  updatePublicSearchSummary(list.length)
  const cfg = getSiteConfig()
  listEl.innerHTML = catalog.length === 0
    ? `<li class="public-empty-item">${escapeHtml(siteText('noPublishedEntity', cfg))}</li>`
    : list.length === 0
      ? `<li class="public-empty-item">${escapeHtml(siteText('noMatchEntity', cfg))}</li>`
      : list.map((c) => `
      <li>
        <button type="button" class="public-cert-btn" data-id="${c.id}">
          ${escapeHtml(c.title)}
          <small>${formatTime(c.published_at)}</small>
        </button>
      </li>
    `).join('')

  listEl.querySelectorAll('.public-cert-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      scheduleLoadCertificate(Number(btn.dataset.id))
      closePublicMenu()
    })
  })

  if (currentCert?.id) setActiveCertListItem(currentCert.id)
}

async function bootstrapPublicViewer() {
  applyPublicResponsiveLayout()
  PUBLIC_MOBILE_MQ.addEventListener('change', applyPublicResponsiveLayout)
  PUBLIC_MOBILE_LANDSCAPE_MQ.addEventListener('change', applyPublicResponsiveLayout)
  window.addEventListener('orientationchange', () => {
    requestAnimationFrame(() => applyPublicResponsiveLayout())
  })
  mountSplitResize()
  mountPageNavResize()
  exposePublicAdornDebug(() => ({
    currentCertId: currentCert?.id ?? null,
    presetId: currentCert?.preset_id ?? null,
    sampleAdornments,
    tableTemplateColumns,
    columnOrder,
    tableColumns: getTableColumns(),
    layoutOverrides: getLayoutOverrides(),
    selectedRow,
    rawRow: getRows()[selectedRow],
    displayRow: getRows()[selectedRow] ? getSvgRowData(selectedRow) : null,
  }))

  const [fontCfg, siteCfg, listRes] = await Promise.all([
    loadFontCatalog(),
    loadSiteConfig(),
    api.listPublicCertificates().catch((err) => {
      console.error('[public] 加载列表失败', err)
      return { certificates: [], error: err?.message || '加载失败' }
    }),
  ])
  fontCatalog = fontCfg
  setActiveFontCatalog(fontCfg)
  fontUrl = fontCfg.defaultUrl
  applyPublicPageBranding(siteCfg)
  if (titleEl && !currentCert) titleEl.textContent = siteText('selectEntity', siteCfg)

  catalog = listRes.certificates || []
  renderPublicCertList()
  void ensureCatalogTableSearchText().then(() => {
    if (certSearch.trim()) renderPublicCertList()
  })

  void warmupCatalogFonts(fontCfg)

  if (catalog.length === 0) {
    const emptyMsg = listRes?.error
      ? `无法加载${siteCfg.entityLabel}：${listRes.error}`
      : siteText('noPublishedEntity', siteCfg)
    resetPublicViewerToSelectPrompt(emptyMsg)
  } else {
    let id = parseCertIdFromPublicLocation(getSiteConfig())
    if (id == null) {
      const groupIds = [...new Set(catalog.map((c) => c.group_id).filter((g) => g != null))]
      for (const gid of groupIds) {
        const cfg = await loadSiteConfigForGroup(gid)
        id = parseCertIdFromPublicLocation(cfg)
        if (id != null) break
      }
    }
    if (id == null) {
      let segment = parsePublicCertSegmentFromLocation(getSiteConfig())
      if (!segment) {
        const groupIds = [...new Set(catalog.map((c) => c.group_id).filter((g) => g != null))]
        for (const gid of groupIds) {
          const cfg = await loadSiteConfigForGroup(gid)
          segment = parsePublicCertSegmentFromLocation(cfg)
          if (segment) break
        }
      }
      if (segment && !/^\d+$/.test(segment)) {
        try {
          const resolved = await api.resolvePublicCertificateBySlug(segment)
          id = resolved.id
        } catch {
          id = null
        }
      }
    }
    if (id != null && id > 0) {
      await loadCertificate(id)
    } else {
      resetPublicViewerToSelectPrompt()
    }
  }
}

certSearchInput?.addEventListener('input', () => {
  certSearch = certSearchInput.value
  renderPublicCertList()
  void ensureCatalogTableSearchText().then(() => {
    if (certSearch.trim()) renderPublicCertList()
  })
})

requireVisitorSession()
  .then((visitor) => {
    if (!visitor) return null

    /** @type {object} */
    let currentUser = { ...visitor }

    const userBar = document.getElementById('public-user-bar')
    if (userBar) userBar.hidden = false

    const isAdminSession = !!visitor.is_admin
    const accountCenter = mountAccountCenter(document.body, {
      getUser: () => currentUser,
      setUser: (user) => { currentUser = user },
      dialogId: 'public-account-dialog',
      chipSelectors: {
        avatar: '#public-user-avatar',
        name: '#public-user-name',
        role: null,
      },
      avatarImgClass: 'public-user-avatar-img',
      fetchProfile: () => (isAdminSession ? api.getProfile() : api.getPublicProfile()),
      updateProfile: (body) => (isAdminSession ? api.updateProfile(body) : api.updatePublicProfile(body)),
      uploadMedia: (file, name) => (isAdminSession ? api.uploadMedia(file, name) : api.uploadPublicMedia(file, name)),
      formatRoleLabel: (user) => {
        if (user?.is_super_admin) return '超级管理员'
        if (user?.is_admin) return '管理员'
        return '访客账号'
      },
    })

    document.getElementById('public-open-account')?.addEventListener('click', () => {
      accountCenter.open()
    })

    document.getElementById('public-logout')?.addEventListener('click', async () => {
      if (isAdminSession) {
        window.location.href = '/admin.html'
        return
      }
      await api.publicLogout()
      window.location.href = await resolvePublicLoginHref()
    })

    return bootstrapPublicViewer()
  })
  .catch((err) => {
    console.error(err)
    previewArea.innerHTML = '<p class="public-empty">加载失败</p>'
  })

function setPublicView(mode) {
  if (!publicContent) return
  publicContent.classList.remove('public-view-both', 'public-view-table', 'public-view-preview')
  publicContent.classList.add(`public-view-${mode}`)
  document.querySelectorAll('.public-view-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === mode)
  })
  if (isPublicMobileLayout()) {
    closePublicSettings()
    closePublicPages()
  }
  renderPublicRowCard()
  if (mode === 'both') {
    requestAnimationFrame(() => {
      restoreTableSplit()
      previewViewport.scheduleFitView?.()
    })
  }
}

function clampTableHeight(height, contentHeight) {
  const handleH = splitHandle?.offsetHeight ?? 8
  const max = contentHeight - handleH - MIN_PREVIEW_HEIGHT
  return Math.max(MIN_TABLE_HEIGHT, Math.min(height, max))
}

function applyTableHeight(px, persist = false) {
  if (!tablePanel || !publicContent) return
  const contentHeight = publicContent.clientHeight
  if (contentHeight <= 0) return
  const clamped = clampTableHeight(px, contentHeight)
  tablePanel.style.flex = `0 0 ${clamped}px`
  if (persist) {
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(clamped)))
    } catch {
      // ignore
    }
  }
}

function restoreTableSplit() {
  if (!tablePanel || !publicContent) return
  const saved = Number(localStorage.getItem(SPLIT_STORAGE_KEY))
  if (saved > 0) {
    applyTableHeight(saved)
    return
  }
  applyTableHeight(publicContent.clientHeight * 0.34)
}

function clampPageNavWidth(width, frameWidth = Infinity) {
  const maxByFrame = Number.isFinite(frameWidth)
    ? Math.max(MIN_PAGE_NAV_WIDTH, Math.min(MAX_PAGE_NAV_WIDTH, frameWidth - 120))
    : MAX_PAGE_NAV_WIDTH
  return Math.max(MIN_PAGE_NAV_WIDTH, Math.min(width, maxByFrame))
}

function applyPageNavWidth(px, { persist = false, frameEl = null } = {}) {
  if (!pageNavEl) return
  const frame = frameEl || pageNavEl.closest('.public-preview-frame')
  const frameWidth = frame?.clientWidth ?? Infinity
  const clamped = clampPageNavWidth(px, frameWidth)
  pageNavEl.style.flexBasis = `${clamped}px`
  pageNavEl.style.width = `${clamped}px`
  if (pageNavResizeEl) {
    pageNavResizeEl.setAttribute('aria-valuenow', String(Math.round(clamped)))
  }
  if (persist) {
    try {
      localStorage.setItem(PAGE_NAV_WIDTH_STORAGE_KEY, String(Math.round(clamped)))
    } catch {
      // ignore
    }
  }
  return clamped
}

function restorePageNavWidth() {
  const saved = Number(localStorage.getItem(PAGE_NAV_WIDTH_STORAGE_KEY))
  applyPageNavWidth(saved > 0 ? saved : DEFAULT_PAGE_NAV_WIDTH)
}

function mountPageNavResize() {
  if (!pageNavEl || !pageNavResizeEl) return

  restorePageNavWidth()

  const frame = pageNavEl.closest('.public-preview-frame')
  window.addEventListener('resize', () => {
    const current = pageNavEl.getBoundingClientRect().width
    applyPageNavWidth(current)
  })

  let dragging = false

  const onMove = (clientX) => {
    if (!dragging || !frame) return
    const rect = frame.getBoundingClientRect()
    applyPageNavWidth(clientX - rect.left, { frameEl: frame })
  }

  const stopDrag = () => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove('public-page-nav-dragging')
    applyPageNavWidth(pageNavEl.getBoundingClientRect().width, { persist: true, frameEl: frame })
  }

  pageNavResizeEl.addEventListener('mousedown', (e) => {
    if (pageNavEl.hidden) return
    dragging = true
    document.body.classList.add('public-page-nav-dragging')
    e.preventDefault()
  })

  pageNavResizeEl.addEventListener('touchstart', (e) => {
    if (pageNavEl.hidden) return
    dragging = true
    document.body.classList.add('public-page-nav-dragging')
  }, { passive: true })

  document.addEventListener('mousemove', (e) => onMove(e.clientX))
  document.addEventListener('mouseup', stopDrag)
  document.addEventListener('touchmove', (e) => {
    if (!dragging) return
    onMove(e.touches[0]?.clientX ?? 0)
  }, { passive: true })
  document.addEventListener('touchend', stopDrag)

  pageNavResizeEl.addEventListener('keydown', (e) => {
    if (pageNavEl.hidden) return
    const step = e.shiftKey ? 24 : 8
    let next = pageNavEl.getBoundingClientRect().width
    if (e.key === 'ArrowLeft') next -= step
    else if (e.key === 'ArrowRight') next += step
    else return
    e.preventDefault()
    applyPageNavWidth(next, { persist: true, frameEl: frame })
  })
}

function mountSplitResize() {
  if (!splitHandle || !tablePanel || !publicContent) return

  restoreTableSplit()
  window.addEventListener('resize', () => {
    if (publicContent.classList.contains('public-view-both')) {
      const current = tablePanel.getBoundingClientRect().height
      applyTableHeight(current)
    }
  })

  let dragging = false

  const onMove = (clientY) => {
    if (!dragging) return
    const rect = publicContent.getBoundingClientRect()
    applyTableHeight(clientY - rect.top)
  }

  const stopDrag = () => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove('public-split-dragging')
    applyTableHeight(tablePanel.getBoundingClientRect().height, true)
  }

  splitHandle.addEventListener('mousedown', (e) => {
    if (!publicContent.classList.contains('public-view-both')) return
    dragging = true
    document.body.classList.add('public-split-dragging')
    e.preventDefault()
  })

  splitHandle.addEventListener('touchstart', (e) => {
    if (!publicContent.classList.contains('public-view-both')) return
    dragging = true
    document.body.classList.add('public-split-dragging')
    e.preventDefault()
  }, { passive: false })

  window.addEventListener('mousemove', (e) => onMove(e.clientY))
  window.addEventListener('mouseup', stopDrag)
  window.addEventListener('touchmove', (e) => {
    if (e.touches[0]) onMove(e.touches[0].clientY)
  }, { passive: true })
  window.addEventListener('touchend', stopDrag)
  window.addEventListener('touchcancel', stopDrag)

  splitHandle.addEventListener('keydown', (e) => {
    if (!publicContent.classList.contains('public-view-both')) return
    const step = e.shiftKey ? 24 : 8
    const current = tablePanel.getBoundingClientRect().height
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next = current + (e.key === 'ArrowDown' ? step : -step)
      applyTableHeight(next, true)
    }
  })
}

let previewPointerMoved = false
/** @type {{ x: number, y: number } | null} */
let previewPointerStart = null

previewArea?.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.public-page-nav')) return
  previewPointerMoved = false
  previewPointerStart = { x: e.clientX, y: e.clientY }
})

previewArea?.addEventListener('pointermove', (e) => {
  if (!previewPointerStart) return
  const dx = e.clientX - previewPointerStart.x
  const dy = e.clientY - previewPointerStart.y
  if (Math.hypot(dx, dy) > 4) previewPointerMoved = true
})

previewArea?.addEventListener('pointerup', () => {
  previewPointerStart = null
})

previewArea?.addEventListener('click', handlePreviewClick)

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.repeat) return
  if (document.body.classList.contains('public-settings-open')) {
    closePublicSettings()
    return
  }
  if (document.body.classList.contains('public-pages-open')) {
    closePublicPages()
    return
  }
  if (document.body.classList.contains('public-menu-open')) {
    closePublicMenu()
    return
  }
  if (document.body.classList.contains('public-preview-fullscreen')) {
    setPublicPreviewFullscreen(false)
    return
  }
  if (e.target?.closest?.('input, textarea, select')) return
  clearPublicSelection()
})

document.querySelectorAll('.public-view-btn').forEach((btn) => {
  btn.addEventListener('click', () => setPublicView(btn.dataset.view || 'both'))
})

prevBtn?.addEventListener('click', () => {
  if (selectedRow > 0) scheduleSelectRow(selectedRow - 1)
})

pageIndexEl?.addEventListener('click', handlePageJumpClick)
pageIndexDrawerEl?.addEventListener('click', handlePageJumpClick)

rowCardFieldsEl?.addEventListener('click', (e) => {
  const item = e.target.closest('.public-row-card-item')
  if (!item) return
  e.stopPropagation()
  const column = item.dataset.column
  if (!column) return
  focusTableColumn(column)
  renderPublicRowCard()
})
rowCardEl?.addEventListener('click', (e) => e.stopPropagation())

nextBtn?.addEventListener('click', () => {
  const rows = getRows()
  if (selectedRow < rows.length - 1) scheduleSelectRow(selectedRow + 1)
})

document.getElementById('public-zoom-in')?.addEventListener('click', () => previewViewport.zoomIn())
document.getElementById('public-zoom-out')?.addEventListener('click', () => previewViewport.zoomOut())
document.getElementById('public-zoom-fit')?.addEventListener('click', () => previewViewport.fitView())
document.getElementById('public-zoom-reset')?.addEventListener('click', () => previewViewport.resetView())

btnPreviewFullscreen?.addEventListener('click', () => {
  setPublicPreviewFullscreen(!document.body.classList.contains('public-preview-fullscreen'))
})

btnPreviewFullscreenExit?.addEventListener('click', () => {
  setPublicPreviewFullscreen(false)
})

const btnPan = document.getElementById('public-pan')
btnPan?.addEventListener('click', () => {
  const on = !previewViewport.getPanMode()
  previewViewport.setPanMode(on)
  btnPan.classList.toggle('active', on)
})

showLayoutBoxesInput?.addEventListener('change', () => {
  showLayoutBoxes = !!showLayoutBoxesInput.checked
  if (layoutEditor) {
    layoutEditor.setVisible(showLayoutBoxes)
  } else if (showLayoutBoxes) {
    attachLayoutEditorToStage()
  }
})

showTemplateLayerInput?.addEventListener('change', () => {
  showTemplateLayer = !!showTemplateLayerInput.checked
  previewFontReady = catalogFontsLoaded
  previewDisplayedRow = -1
  rowSvgCache.clear()
  scheduleSelectRow(selectedRow, { keepColumn: true })
})

btnExportSvg?.addEventListener('click', async () => {
  const rows = getRows()
  if (!rows.length) return setExportStatus('没有数据')
  setExportStatus('正在导出 SVG…', 0)
  try {
    const svgEl = await buildSvgForExport(selectedRow)
    const name = rows[selectedRow]['编号'] || `cert-${selectedRow + 1}`
    const blob = new Blob([await serializeSvgForExport(svgEl)], { type: 'image/svg+xml;charset=utf-8' })
    downloadBlob(blob, `${sanitizeFilename(name)}.svg`)
    setExportStatus('SVG 已导出')
    trackActivity('svg_download')
  } catch (err) {
    console.error(err)
    setExportStatus('SVG 导出失败: ' + (err.message || '未知错误'))
  }
})

btnExportPdf?.addEventListener('click', async () => {
  const rows = getRows()
  if (!rows.length) return setExportStatus('没有数据')
  setExportStatus('正在生成 PDF…', 0)
  btnExportPdf.disabled = true
  try {
    const svgEl = await buildSvgForExport(selectedRow)
    const name = rows[selectedRow]['编号'] || `cert-${selectedRow + 1}`
    await exportSvgToPdf(svgEl, `${sanitizeFilename(name)}.pdf`, pdfExportOptionsFromApp())
    setExportStatus('PDF 已导出')
    trackActivity('pdf_download')
  } catch (err) {
    console.error(err)
    setExportStatus('PDF 导出失败: ' + (err.message || '未知错误'))
  } finally {
    updateExportButtons()
  }
})

btnExportBatch?.addEventListener('click', async () => {
  const rows = getRows()
  if (!rows.length) return setExportStatus('没有数据')
  setExportControlsDisabled(true)
  exportProgressTotalPages = rows.length
  setExportProgress({
    title: '正在导出全部 PDF',
    message: '准备导出…',
    percent: 0,
    stepId: 'init',
    doneSteps: [],
    total: rows.length,
  })
  try {
    if (catalogFontsLoaded) {
      exportFontsStepState = 'skipped'
      exportProgressSkippedSteps.add('fonts')
      exportProgressStepLabels.fonts = '预加载字体（已加载）'
      setExportProgress({
        message: '字体已预加载，跳过此步骤',
        percent: 4,
        stepId: 'fonts',
        doneSteps: ['init', 'fonts'],
        skippedSteps: ['fonts'],
        stepLabels: { fonts: '预加载字体（已加载）' },
      })
    } else {
      exportFontsStepState = 'loading'
      setExportProgress({
        message: '正在预加载证书字体…',
        percent: 3,
        stepId: 'fonts',
        doneSteps: ['init'],
      })
      if (fontCatalog) await warmupCatalogFonts(fontCatalog)
      exportFontsStepState = 'done'
      setExportProgress({
        message: '字体预加载完成',
        percent: 5,
        stepId: 'doc',
        doneSteps: ['init', 'fonts'],
      })
    }
    const filename = `${sanitizeFilename(currentCert?.title || `certificates-${rows.length}`)}.pdf`
    await exportRowsToSinglePdf(
      rows,
      (_row, i) => buildSvgForExport(i),
      pdfExportOptionsFromApp(),
      filename,
      applyPdfExportProgress,
    )
    setExportStatus(`已导出 ${rows.length} 页 PDF`)
    hideExportProgress(2200)
  } catch (err) {
    console.error(err)
    hideExportProgress(0)
    setExportStatus('导出失败: ' + (err.message || '未知错误'))
  } finally {
    setExportControlsDisabled(false)
  }
})

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleDateString('zh-CN')
  } catch {
    return ''
  }
}

// ---- 访客行为追踪 ----
let trackPageEnteredAt = Date.now()
let trackCertId = null
let trackCertTitle = ''

function trackActivity(activityType, opts = {}) {
  const payload = {
    activity_type: activityType,
    cert_id: trackCertId ?? (opts.cert_id ?? null),
    cert_title: trackCertTitle || (opts.cert_title || ''),
    duration_seconds: opts.duration_seconds ?? 0,
    referrer: document.referrer || '',
    details: opts.details ? JSON.stringify(opts.details) : '{}',
  }
  // 卸载时用 sendBeacon 确保送达
  if (opts.beacon && navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    navigator.sendBeacon('/api/track', blob)
    return
  }
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => { /* 追踪失败不影响主功能 */ })
}

// 记录一次公开页访问（即使未点开证书也有数据）
function trackPageVisit() {
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activity_type: 'page_visit',
      cert_id: null,
      cert_title: '',
      duration_seconds: 0,
      referrer: document.referrer || '',
      details: JSON.stringify({ path: window.location.pathname }),
    }),
    keepalive: true,
  }).catch(() => {})
}
trackPageVisit()

function setTrackingCert(cert) {
  trackCertId = cert?.id ?? null
  trackCertTitle = cert?.title || ''
  trackPageEnteredAt = Date.now()
  if (trackCertId) {
    trackActivity('page_view')
  }
}

function trackDuration() {
  if (!trackCertId) return
  const sec = Math.round((Date.now() - trackPageEnteredAt) / 1000)
  if (sec < 1) return
  trackActivity('page_view', { duration_seconds: sec, beacon: true })
}

// 页面关闭/隐藏时上报停留时长
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') trackDuration()
})
window.addEventListener('beforeunload', () => trackDuration())

