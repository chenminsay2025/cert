import { api } from '../api/client.js'
import { mountSpreadsheetTable } from '../spreadsheetTable.js'
import { formatImageCellValue } from '../cellMedia.js'
import { emptyRow, parseDataCellRowsFromTSVText } from '../svgEngine.js'
import {
  downloadJsonFile,
  readJsonFile,
  askImportConflictMode,
  alertImportDetails,
  formatImportResultMessage,
  dataTransferMenuHtml,
  setupDataTransferMenu,
} from './dataTransferUi.js'
import {
  loadAccessibleGroups,
  pickGroupIdForCreate,
  userNeedsGroupPick,
  defaultGroupIdForUser,
  shouldShowGroupUi,
} from './groupUtils.js'
import { groupSelectFieldHtml, readGroupSelectValue, groupBadgeHtml } from './groupSelectorUi.js'

/**
 * @param {HTMLElement} container
 * @param {{
 *   user?: { is_super_admin?: boolean, group_ids?: number[] },
 *   onChange?: () => void,
 *   getCurrentColumns?: () => string[],
 *   getCurrentTableData?: () => Record<string, string>[],
 * }} [options]
 */
export function mountTableTemplatesPanel(container, options = {}) {
  container.innerHTML = `
    <div class="wp-settings-panel-inner table-templates-panel table-templates-panel--wide">
      <header class="wp-settings-header">
        <div>
          <h2 class="wp-settings-title">表格模板库</h2>
          <p class="wp-settings-desc">每个表格模板<strong>相互独立</strong>：列名、示例数据与保存内容仅属于该模板。与证书编辑页相同的表格操作：首行为<strong>列标题</strong>（可双击修改），下方为<strong>示例数据行</strong>（可增删、粘贴、插入图片）。保存后供证书与布局模板引用。模板按<strong>访问组</strong>隔离。</p>
        </div>
        <div class="templates-header-actions">
          ${dataTransferMenuHtml({ prefix: 'tbl-tpl' })}
          <button type="button" class="button" id="tbl-tpl-delete" disabled>删除</button>
          <button type="button" class="button button-primary" id="tbl-tpl-new">新建空模板</button>
        </div>
      </header>
      <div class="table-templates-layout">
        <div class="table-templates-sidebar">
          <p class="templates-list-hint">点击模板名称选中（双击可重命名）</p>
          <ul id="tbl-tpl-list" class="table-templates-list"></ul>
        </div>
        <div class="table-templates-editor" id="tbl-tpl-editor" hidden>
          <div class="tbl-tpl-editor-head">
            <div class="tbl-tpl-editor-head-main">
              <h3 class="tbl-tpl-editor-title" id="tbl-tpl-editor-title">编辑模板</h3>
              <div class="tbl-tpl-editor-meta" id="tbl-tpl-group-field"></div>
            </div>
            <div class="tbl-tpl-editor-actions">
              <button type="button" class="button button-sm" id="tbl-tpl-import-current" title="用当前证书编辑区的列与数据覆盖">从当前证书导入</button>
              <button type="button" class="button button-sm" id="tbl-tpl-clear-table">清空示例行</button>
              <button type="button" class="button button-sm button-primary" id="tbl-tpl-save">保存模板</button>
            </div>
          </div>
          <div class="tbl-tpl-table-toolbar">
            <button type="button" class="button button-sm button-primary" id="tbl-tpl-add-row">+ 添加示例数据行</button>
            <span class="tbl-tpl-row-count" id="tbl-tpl-row-count" aria-live="polite"></span>
          </div>
          <div id="tbl-tpl-table-wrap" class="tbl-tpl-table-wrap" tabindex="0"></div>
          <p class="tbl-tpl-editor-status" id="tbl-tpl-editor-status" aria-live="polite"></p>
        </div>
      </div>
    </div>
  `

  const listEl = container.querySelector('#tbl-tpl-list')
  const layoutEl = container.querySelector('.table-templates-layout')
  const editorEl = container.querySelector('#tbl-tpl-editor')
  const editorTitleEl = container.querySelector('#tbl-tpl-editor-title')
  const tableWrapEl = container.querySelector('#tbl-tpl-table-wrap')
  const editorStatusEl = container.querySelector('#tbl-tpl-editor-status')
  const deleteBtn = container.querySelector('#tbl-tpl-delete')
  const newBtn = container.querySelector('#tbl-tpl-new')
  const importCurrentBtn = container.querySelector('#tbl-tpl-import-current')
  const addRowBtn = container.querySelector('#tbl-tpl-add-row')
  const clearTableBtn = container.querySelector('#tbl-tpl-clear-table')
  const saveBtn = container.querySelector('#tbl-tpl-save')
  const rowCountEl = container.querySelector('#tbl-tpl-row-count')
  const groupFieldEl = container.querySelector('#tbl-tpl-group-field')

  /** @type {{ id: number, name: string, columns?: string[], sample_rows?: Record<string, string>[], group_id?: number | null }[]} */
  let templates = []
  /** @type {{ id: number, name: string }[]} */
  let accessGroups = []
  let currentId = null
  let draftColumns = []
  /** @type {Record<string, string>[]} */
  let draftRows = []
  let draftDirty = false
  let selectedRow = 0
  /** @type {ReturnType<typeof mountSpreadsheetTable> | null} */
  let spreadsheet = null

  function showListError(msg) {
    listEl.innerHTML = `<li class="templates-empty-item templates-error">${escapeHtml(msg)}</li>`
  }

  function setEditorStatus(msg, isError = false) {
    if (!editorStatusEl) return
    editorStatusEl.textContent = msg || ''
    editorStatusEl.classList.toggle('is-error', !!isError)
  }

  function markDirty() {
    draftDirty = true
    setEditorStatus('有未保存的修改')
  }

  function syncSelectionActions() {
    deleteBtn.disabled = currentId == null
  }

  function syncRowCountUi() {
    if (!rowCountEl) return
    const n = draftRows.length
    rowCountEl.textContent = n ? `当前 ${n} 行示例数据` : '暂无示例数据行，请点击上方按钮添加'
  }

  function syncEditorVisibility() {
    const hasSelection = currentId != null
    editorEl.hidden = !hasSelection
    layoutEl?.classList.toggle('table-templates-layout--solo', !hasSelection)
  }

  function normalizeRowsForColumns(rows, cols) {
    return (rows || []).map((row) => {
      const out = {}
      for (const col of cols) {
        out[col] = row && row[col] != null ? String(row[col]) : ''
      }
      return out
    })
  }

  function applyColumnOrder(cols) {
    draftColumns = [...cols]
    draftRows = normalizeRowsForColumns(draftRows, draftColumns)
  }

  function nextNewColumnName(existing) {
    let n = existing.length + 1
    let name = `列${n}`
    while (existing.includes(name)) {
      n += 1
      name = `列${n}`
    }
    return name
  }

  function rowFromValues(values, cols) {
    const row = {}
    cols.forEach((col, i) => {
      row[col] = values[i] != null ? String(values[i]) : ''
    })
    return row
  }

  function collectDraftFromSpreadsheet() {
    if (!spreadsheet) return
    spreadsheet.flushEdits()
    draftColumns = [...spreadsheet.getColumns()]
    const cols = draftColumns.length ? draftColumns : ['列1']
    if (!draftColumns.length) draftColumns = [...cols]
    draftRows = normalizeRowsForColumns(draftRows, cols)
  }

  async function setCellImageAt(rowIndex, colIndex, file) {
    const cols = draftColumns.length ? draftColumns : ['列1']
    const col = cols[colIndex]
    if (!col || rowIndex < 0 || rowIndex >= draftRows.length) return
    setEditorStatus('正在上传图片…')
    try {
      const { url } = await api.uploadMedia(file)
      draftRows[rowIndex][col] = formatImageCellValue(url)
      markDirty()
      renderSpreadsheet()
      setEditorStatus('图片已上传，请保存模板')
    } catch (err) {
      console.error(err)
      setEditorStatus(err.message || '图片上传失败（请确认已登录且后端可用）', true)
    }
  }

  function renderSpreadsheet() {
    ensureSpreadsheet().render()
    syncRowCountUi()
  }

  function addSampleRow() {
    const cols = draftColumns.length ? draftColumns : ['列1']
    if (!draftColumns.length) draftColumns = [...cols]
    draftRows.push(emptyRow(cols))
    selectedRow = draftRows.length - 1
    markDirty()
    renderSpreadsheet()
  }

  function ensureSpreadsheet() {
    if (spreadsheet) return spreadsheet
    spreadsheet = mountSpreadsheetTable(tableWrapEl, {
      getData: () => draftRows,
      setData: (rows) => {
        draftRows = normalizeRowsForColumns(rows, draftColumns)
        markDirty()
      },
      syncDataAfterPaste: true,
      documentPasteScope: () => {
        if (!document.querySelector('#cms-view-table-templates.is-active')) return false
        if (currentId == null) return false
        const ae = document.activeElement
        return !!(ae?.closest?.('.table-templates-editor') || ae?.closest?.('#tbl-tpl-table-wrap'))
      },
      getColumns: () => draftColumns,
      getSelectedRow: () => selectedRow,
      setSelectedRow: (i) => { selectedRow = i },
      onCellChange: () => markDirty(),
      onSetCellImage: (rowIndex, colIndex, file) => setCellImageAt(rowIndex, colIndex, file),
      onReorderColumn: (from, to) => {
        const cols = [...draftColumns]
        const fromIdx = Math.max(0, Math.min(from, cols.length - 1))
        let toIdx = Math.max(0, Math.min(to, cols.length - 1))
        if (fromIdx === toIdx) return
        const [moved] = cols.splice(fromIdx, 1)
        cols.splice(toIdx, 0, moved)
        applyColumnOrder(cols)
        markDirty()
        renderSpreadsheet()
      },
      onRenameColumn: (colIndex, oldName, newName) => {
        const trimmed = String(newName || '').trim()
        if (!trimmed || trimmed === oldName) return
        const cols = [...draftColumns]
        if (cols.includes(trimmed) && trimmed !== oldName) {
          setEditorStatus(`列名「${trimmed}」已存在`, true)
          renderSpreadsheet()
          return
        }
        cols[colIndex] = trimmed
        draftRows = draftRows.map((row) => {
          const next = {}
          for (const col of cols) {
            next[col] = col === oldName ? (row[oldName] ?? '') : (row[col] ?? '')
          }
          return next
        })
        applyColumnOrder(cols)
        markDirty()
        renderSpreadsheet()
      },
      onAddColumnRight: (colIndex) => {
        const cols = [...draftColumns]
        const name = nextNewColumnName(cols)
        cols.splice(colIndex + 1, 0, name)
        applyColumnOrder(cols)
        for (const row of draftRows) {
          row[name] = ''
        }
        markDirty()
        renderSpreadsheet()
      },
      onDeleteColumn: (colIndex) => {
        const col = draftColumns[colIndex]
        if (!col) return
        if (!window.confirm(`删除列「${col}」？`)) {
          renderSpreadsheet()
          return
        }
        const cols = draftColumns.filter((_, i) => i !== colIndex)
        applyColumnOrder(cols)
        draftRows = draftRows.map((row) => {
          const next = { ...row }
          delete next[col]
          return next
        })
        markDirty()
        renderSpreadsheet()
      },
      onAddRowBelow: (rowIndex) => {
        const cols = draftColumns.length ? draftColumns : ['列1']
        if (!draftColumns.length) draftColumns = [...cols]
        const insertAt = Math.min(rowIndex + 1, draftRows.length)
        draftRows.splice(insertAt, 0, emptyRow(cols))
        markDirty()
        renderSpreadsheet()
      },
      onDeleteRow: (rowIndex) => {
        if (rowIndex < 0 || rowIndex >= draftRows.length) return
        draftRows.splice(rowIndex, 1)
        selectedRow = Math.min(selectedRow, Math.max(0, draftRows.length - 1))
        markDirty()
        renderSpreadsheet()
      },
      parsePaste: (text) => {
        const cols = draftColumns.length ? draftColumns : ['列1']
        return parseDataCellRowsFromTSVText(text).map((cells) => rowFromValues(cells, cols))
      },
      onEnsureRowCount: (count) => {
        const cols = draftColumns.length ? draftColumns : ['列1']
        if (!draftColumns.length) draftColumns = [...cols]
        while (draftRows.length < count) {
          draftRows.push(emptyRow(cols))
        }
      },
      onPasteTrimRows: (count) => {
        if (count > 0 && count < draftRows.length) {
          draftRows.length = count
          selectedRow = Math.min(selectedRow, Math.max(0, count - 1))
        }
      },
    })
    return spreadsheet
  }

  async function ensureApiReady() {
    let meta
    try {
      meta = await api.meta()
    } catch {
      throw new Error('无法连接后端 (端口 3003)。请执行 npm run dev:local 并刷新页面')
    }
    if (!Array.isArray(meta?.features)) {
      throw new Error('后端 API 响应异常。请确认 npm run dev:local 已启动，然后硬刷新页面 (Ctrl+Shift+R)')
    }
    if (!meta.features.includes('table_templates')) {
      throw new Error('后端版本过旧，缺少表格模板功能。请重启 npm run dev:server')
    }
    if (!meta.features?.includes('table_template_sample_rows')) {
      throw new Error('后端 API 过旧，无法保存示例行。请 Ctrl+C 停止后重新运行 npm run dev:local')
    }
    if (!meta.features?.includes('media_upload')) {
      throw new Error('后端未启用图片上传（media_upload）。请重启 npm run dev:server')
    }
    return meta
  }

  function renderEditorGroupField(groupId) {
    if (!groupFieldEl) return
    if (!shouldShowGroupUi(options.user, accessGroups)) {
      groupFieldEl.innerHTML = ''
      return
    }
    groupFieldEl.innerHTML = groupSelectFieldHtml({
      selectId: 'tbl-tpl-edit-group',
      groups: accessGroups,
      user: options.user,
      selectedId: groupId,
      compact: true,
    })
  }

  async function resolveGroupIdForCreate() {
    if (userNeedsGroupPick(options.user)) {
      return pickGroupIdForCreate(options.user, '新建表格模板的访问组')
    }
    return defaultGroupIdForUser(options.user, accessGroups)
  }

  async function loadDraftFromTemplate(t) {
    let template = t
    if (t?.id) {
      const res = await api.getTableTemplate(t.id)
      template = res.template
    }
    draftColumns = [...(template?.columns || [])]
    if (!draftColumns.length) draftColumns = ['列1']
    draftRows = normalizeRowsForColumns(template?.sample_rows || [], draftColumns)
    selectedRow = 0
    draftDirty = false
    editorTitleEl.textContent = template ? `编辑：${template.name}` : '编辑模板'
    renderEditorGroupField(template?.group_id ?? null)
    renderSpreadsheet()
    setEditorStatus('')
  }

  async function refreshList(selectId = currentId, { reloadEditor = true } = {}) {
    const res = await api.listTableTemplates()
    templates = res.templates || []

    if (templates.length === 0) {
      listEl.innerHTML = '<li class="templates-empty-item">暂无模板，请点击「新建空模板」</li>'
      currentId = null
      draftColumns = []
      draftRows = []
      syncSelectionActions()
      syncEditorVisibility()
      renderEditorGroupField(null)
      return
    }

    listEl.innerHTML = templates.map((t) => `
      <li>
        <button type="button" class="tbl-tpl-list-item${t.id === selectId ? ' is-active' : ''}" data-id="${t.id}">
          <span class="tbl-tpl-list-name">${escapeHtml(t.name)}</span>
          <span class="tbl-tpl-list-meta">${groupBadgeHtml(t.group_id, accessGroups)}${t.column_count ?? t.columns?.length ?? 0} 列 · ${t.sample_row_count ?? 0} 行示例</span>
        </button>
      </li>
    `).join('')

    listEl.querySelectorAll('.tbl-tpl-list-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        void selectTemplate(Number(btn.dataset.id))
      })
    })

    if (selectId != null && templates.some((t) => t.id === selectId)) {
      currentId = selectId
      if (reloadEditor && !draftDirty) {
        const row = templates.find((x) => x.id === selectId)
        await loadDraftFromTemplate(row)
      }
    } else if (!currentId && templates.length > 0) {
      await selectTemplate(templates[0].id)
    } else {
      syncSelectionActions()
      syncEditorVisibility()
    }
  }

  async function confirmDiscardDraft() {
    if (!draftDirty) return true
    return window.confirm('当前模板有未保存修改，继续将丢失，确定？')
  }

  async function selectTemplate(id) {
    if (id === currentId) return
    if (!(await confirmDiscardDraft())) return
    currentId = id
    const row = templates.find((x) => x.id === id)
    await loadDraftFromTemplate(row)
    syncSelectionActions()
    syncEditorVisibility()
    listEl.querySelectorAll('.tbl-tpl-list-item').forEach((btn) => {
      btn.classList.toggle('is-active', Number(btn.dataset.id) === id)
    })
  }

  saveBtn?.addEventListener('click', async () => {
    if (!currentId) return
    collectDraftFromSpreadsheet()
    const cols = draftColumns.map((c) => c.trim()).filter(Boolean)
    const seen = new Set()
    for (const col of cols) {
      if (seen.has(col)) {
        setEditorStatus(`列名重复：「${col}」`, true)
        return
      }
      seen.add(col)
    }
    if (!cols.length) {
      setEditorStatus('至少保留一列', true)
      return
    }
    try {
      const sampleRows = normalizeRowsForColumns(draftRows, cols)
      const groupId = readGroupSelectValue(container, 'tbl-tpl-edit-group', accessGroups, options.user)
      const payload = {
        columns: cols,
        sample_rows: sampleRows,
      }
      if (groupId != null) payload.group_id = groupId
      const res = await api.updateTableTemplate(currentId, payload)
      const savedRows = Array.isArray(res.template?.sample_rows)
        ? res.template.sample_rows
        : sampleRows
      const savedCount = res.template?.sample_row_count ?? savedRows.length
      if (sampleRows.length > 0 && savedCount === 0) {
        setEditorStatus('保存失败：服务端未写入示例行。请停止 dev 后重新运行 npm run dev:local', true)
        return
      }
      draftColumns = cols
      draftRows = normalizeRowsForColumns(savedRows, cols)
      draftDirty = false
      const tpl = templates.find((t) => t.id === currentId)
      if (tpl) {
        tpl.columns = cols
        tpl.sample_rows = draftRows
        tpl.column_count = cols.length
        tpl.sample_row_count = draftRows.length
        if (res.template?.group_id != null) tpl.group_id = res.template.group_id
      }
      const presetCount = res.layout_presets_updated ?? 0
      const syncHint = presetCount > 0
        ? `；已同步 ${presetCount} 个关联布局模板的列引用`
        : ''
      setEditorStatus(`已保存（${cols.length} 列，${draftRows.length} 行示例${syncHint}）`)
      await refreshList(currentId, { reloadEditor: false })
      renderSpreadsheet()
      syncRowCountUi()
      options.onChange?.()
    } catch (err) {
      setEditorStatus(err.message || '保存失败', true)
    }
  })

  addRowBtn?.addEventListener('click', () => {
    if (!currentId) return
    addSampleRow()
  })

  clearTableBtn?.addEventListener('click', () => {
    if (!currentId) return
    if (!window.confirm('清空所有示例数据行？列标题将保留。')) return
    draftRows = []
    selectedRow = 0
    markDirty()
    renderSpreadsheet()
    setEditorStatus('示例行已清空，请保存')
  })

  importCurrentBtn?.addEventListener('click', () => {
    try {
      const cols = options.getCurrentColumns?.()
      if (!Array.isArray(cols) || !cols.length) {
        throw new Error('当前证书没有列结构。请先在证书编辑页打开一张证书。')
      }
      const data = options.getCurrentTableData?.()
      if (!Array.isArray(data) || !data.length) {
        throw new Error('当前证书没有数据行。')
      }
      draftColumns = cols.map((c) => String(c).trim()).filter(Boolean)
      draftRows = normalizeRowsForColumns(data, draftColumns)
      draftDirty = true
      renderSpreadsheet()
      setEditorStatus(`已导入 ${draftColumns.length} 列、${draftRows.length} 行，请保存`)
    } catch (err) {
      alert(err.message || '导入失败')
    }
  })

  deleteBtn?.addEventListener('click', async () => {
    if (!currentId) return
    const existing = templates.find((t) => t.id === currentId)
    if (!window.confirm(`确定删除表格模板「${existing?.name || currentId}」？`)) return
    try {
      await api.deleteTableTemplate(currentId)
      currentId = null
      draftColumns = []
      draftRows = []
      draftDirty = false
      spreadsheet?.dispose?.()
      spreadsheet = null
      tableWrapEl.innerHTML = ''
      await refreshList()
      options.onChange?.()
    } catch (err) {
      alert(err.message || '删除失败')
    }
  })

  newBtn?.addEventListener('click', async () => {
    if (!(await confirmDiscardDraft())) return
    const name = window.prompt('模板名称', '新表格')
    if (name == null || !name.trim()) return
    try {
      const columns = ['列1']
      const sampleRows = [emptyRow(columns)]
      const groupId = await resolveGroupIdForCreate()
      if (groupId == null && userNeedsGroupPick(options.user)) return
      const body = { name: name.trim(), columns, sample_rows: sampleRows }
      if (groupId != null) body.group_id = groupId
      const { id } = await api.createTableTemplate(body)
      currentId = id
      draftDirty = false
      await refreshList(id)
      await loadDraftFromTemplate({ id, name: name.trim(), columns, sample_rows: sampleRows, group_id: groupId })
      syncEditorVisibility()
      options.onChange?.()
      setEditorStatus('已创建，请编辑后保存')
    } catch (err) {
      alert(err.message || '创建失败')
    }
  })

  listEl.addEventListener('dblclick', async (e) => {
    const btn = e.target.closest('.tbl-tpl-list-item')
    if (!btn) return
    const id = Number(btn.dataset.id)
    const t = templates.find((x) => x.id === id)
    if (!t) return
    const name = window.prompt('模板名称', t.name)
    if (name == null || !name.trim() || name.trim() === t.name) return
    try {
      await api.updateTableTemplate(id, { name: name.trim() })
      await refreshList(id)
      options.onChange?.()
    } catch (err) {
      alert(err.message || '重命名失败')
    }
  })

  setupDataTransferMenu(container, {
    prefix: 'tbl-tpl',
    onExport: async () => {
      try {
        const ids = currentId ? [currentId] : null
        if (!currentId && templates.length) {
          const ok = window.confirm('未选中模板，是否导出全部表格模板？')
          if (!ok) return
        }
        const bundle = await api.exportTableTemplates(ids)
        const stamp = new Date().toISOString().slice(0, 10)
        downloadJsonFile(`table-templates-${stamp}.json`, bundle)
        setEditorStatus(`已导出 ${bundle.item_count ?? bundle.items?.length ?? 0} 个表格模板`)
      } catch (err) {
        setEditorStatus(err.message || '导出失败')
      }
    },
    onImport: async () => {
      try {
        const mode = askImportConflictMode()
        const bundle = await readJsonFile()
        const result = await api.importTableTemplates(bundle, mode)
        alertImportDetails(result)
        await refreshList(result.ids?.[0] ?? currentId)
        options.onChange?.()
        setEditorStatus(formatImportResultMessage(result, '表格模板'))
      } catch (err) {
        if (err?.message !== 'cancelled') setEditorStatus(err.message || '导入失败')
      }
    },
  })

  return {
    async init() {
      try {
        await ensureApiReady()
        accessGroups = await loadAccessibleGroups(true)
        await refreshList()
      } catch (err) {
        console.error(err)
        showListError(err.message || '加载表格模板失败')
      }
    },
    async repaint() {
      try {
        await ensureApiReady()
        accessGroups = await loadAccessibleGroups(true)
        await refreshList(currentId)
      } catch (err) {
        console.error(err)
        showListError(err.message || '加载表格模板失败')
      }
    },
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

if (document.body?.classList.contains('table-templates-page-standalone')) {
  const next = new URL('/admin.html', window.location.origin)
  next.searchParams.set('view', 'table-templates')
  window.location.replace(next.pathname + next.search)
}
