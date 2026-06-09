import { api } from '../api/client.js'
import { mountIsolatedSvgPreview, unmountIsolatedSvgPreview } from '../svgPreview.js'
import { invalidateSvgTemplateCache, loadSvgTemplateContent } from '../svgTemplateLoader.js'
import { loadAccessibleGroups, shouldShowGroupUi, defaultGroupIdForUser, groupNameById } from './groupUtils.js'
import { groupSelectFieldHtml, readGroupSelectValue } from './groupSelectorUi.js'

/**
 * @param {HTMLElement} container
 * @param {{ user?: { is_super_admin?: boolean, group_ids?: number[] }, onChange?: () => void }} [options]
 */
export function mountTemplatesPanel(container, options = {}) {
  container.innerHTML = `
    <div class="wp-settings-panel-inner templates-panel">
      <header class="wp-settings-header">
        <div>
          <h2 class="wp-settings-title">SVG 模板库</h2>
          <p class="wp-settings-desc">在此上传、替换或删除多个 SVG 文件（保存到服务器 data/svg-templates/ 目录）。每张证书使用哪套模板，请在「证书编辑」页面的「本证书模板」中选择，不在此页指定。模板按<strong>访问组</strong>隔离，仅同组管理员可见。</p>
        </div>
        <div class="templates-header-actions">
          <button type="button" class="button button-primary" id="tpl-new">上传 SVG</button>
        </div>
      </header>
      <div class="tpl-upload-form-wrap" id="tpl-upload-form-wrap" hidden>
        <form id="tpl-upload-form" class="tpl-upload-form">
          <div class="tpl-upload-form-grid">
            <label class="tpl-upload-field">
              <span class="tpl-upload-label">SVG 文件</span>
              <input type="file" id="tpl-upload-file" name="file" accept=".svg,image/svg+xml" required />
            </label>
            <label class="tpl-upload-field">
              <span class="tpl-upload-label">名称</span>
              <input type="text" id="tpl-upload-name" name="name" maxlength="120" placeholder="模板名称" autocomplete="off" spellcheck="false" />
            </label>
            <div class="tpl-upload-field" id="tpl-upload-group-slot"></div>
          </div>
          <div class="tpl-upload-form-actions">
            <button type="submit" class="button button-primary">上传</button>
            <button type="button" class="button" id="tpl-upload-cancel">取消</button>
          </div>
          <p class="tpl-upload-form-status" id="tpl-upload-form-status" aria-live="polite"></p>
        </form>
      </div>
      <div class="templates-main">
        <div class="templates-gallery-wrap">
          <ul id="tpl-list" class="templates-grid"></ul>
        </div>
      </div>
      <input type="file" id="tpl-replace-file" accept=".svg,image/svg+xml" hidden />
    </div>
  `

  const listEl = container.querySelector('#tpl-list')
  const uploadFormWrap = container.querySelector('#tpl-upload-form-wrap')
  const uploadForm = container.querySelector('#tpl-upload-form')
  const uploadFileInput = container.querySelector('#tpl-upload-file')
  const uploadNameInput = container.querySelector('#tpl-upload-name')
  const uploadGroupSlot = container.querySelector('#tpl-upload-group-slot')
  const uploadFormStatus = container.querySelector('#tpl-upload-form-status')
  const replaceFileInput = container.querySelector('#tpl-replace-file')

  /** @type {{ id: number, name: string, slug: string, group_id?: number | null, svg_bytes?: number }[]} */
  let templates = []
  /** @type {{ id: number, name: string }[]} */
  let accessGroups = []
  /** @type {Map<number, string>} */
  const svgCache = new Map()
  /** @type {Set<number>} */
  const savingCardIds = new Set()
  /** @type {Set<number>} */
  const editingCardIds = new Set()
  let replaceTargetId = null
  let listUiBound = false

  function showListError(msg) {
    listEl.innerHTML = `<li class="templates-empty-item templates-error">${escapeHtml(msg)}</li>`
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }

  async function getTemplateSvg(id) {
    if (svgCache.has(id)) return svgCache.get(id)
    const svg = await loadSvgTemplateContent(api, id)
    svgCache.set(id, svg)
    return svg
  }

  function setUploadFormStatus(msg, isError = false) {
    if (!uploadFormStatus) return
    uploadFormStatus.textContent = msg || ''
    uploadFormStatus.classList.toggle('is-error', !!isError)
  }

  function renderUploadGroupField() {
    if (!uploadGroupSlot) return
    if (!shouldShowGroupUi(options.user, accessGroups)) {
      uploadGroupSlot.innerHTML = ''
      return
    }
    const defaultGroup = defaultGroupIdForUser(options.user, accessGroups)
    uploadGroupSlot.innerHTML = groupSelectFieldHtml({
      selectId: 'tpl-upload-group',
      groups: accessGroups,
      user: options.user,
      selectedId: defaultGroup,
      compact: false,
    })
  }

  function showUploadForm(show) {
    if (!uploadFormWrap) return
    uploadFormWrap.hidden = !show
    if (show) {
      uploadForm?.reset()
      renderUploadGroupField()
      setUploadFormStatus('')
      uploadNameInput?.focus()
    }
  }

  function renderCardGroupField(t) {
    if (!shouldShowGroupUi(options.user, accessGroups)) return ''
    return groupSelectFieldHtml({
      selectId: `tpl-group-${t.id}`,
      groups: accessGroups,
      user: options.user,
      selectedId: t.group_id,
      compact: true,
    })
  }

  function cardEl(id) {
    return listEl.querySelector(`.tpl-card[data-id="${id}"]`)
  }

  function readCardDraft(id) {
    const card = cardEl(id)
    if (!card) return null
    const name = card.querySelector('.tpl-card-edit .tpl-card-name-input')?.value.trim() ?? ''
    const groupEl = card.querySelector(`.tpl-card-edit #tpl-group-${id}`)
    let groupId = null
    if (groupEl) {
      groupId = groupEl.tagName === 'INPUT'
        ? Number(groupEl.value) || null
        : Number(groupEl.value) || null
    }
    return { id, name, groupId }
  }

  function savedSnapshot(t) {
    return {
      name: String(t.name || '').trim(),
      groupId: t.group_id != null ? Number(t.group_id) : null,
    }
  }

  function isCardDirty(id) {
    const t = templates.find((x) => x.id === id)
    const draft = readCardDraft(id)
    if (!t || !draft) return false
    const saved = savedSnapshot(t)
    return draft.name !== saved.name || draft.groupId !== saved.groupId
  }

  function setCardStatus(id, msg, isError = false) {
    const el = cardEl(id)?.querySelector('.tpl-card-status')
    if (!el) return
    el.textContent = msg || ''
    el.classList.toggle('is-error', !!isError)
  }

  function syncCardDirtyState(id) {
    const card = cardEl(id)
    if (!card) return
    const dirty = editingCardIds.has(id) && isCardDirty(id)
    card.classList.toggle('is-dirty', dirty)
    const saveBtn = card.querySelector('.tpl-card-save')
    if (saveBtn) {
      saveBtn.disabled = !dirty || savingCardIds.has(id)
    }
  }

  function restoreCardDraft(id) {
    const t = templates.find((x) => x.id === id)
    const card = cardEl(id)
    if (!t || !card) return
    const nameInput = card.querySelector('.tpl-card-edit .tpl-card-name-input')
    if (nameInput) nameInput.value = t.name || ''
    const groupEl = card.querySelector(`.tpl-card-edit #tpl-group-${id}`)
    if (groupEl && t.group_id != null) groupEl.value = String(t.group_id)
  }

  function updateCardViewDisplay(id) {
    const t = templates.find((x) => x.id === id)
    const card = cardEl(id)
    if (!t || !card) return
    const nameEl = card.querySelector('.tpl-card-name-display')
    if (nameEl) nameEl.textContent = t.name || ''
    const groupEl = card.querySelector('.tpl-card-group-display')
    if (groupEl) groupEl.textContent = groupNameById(accessGroups, t.group_id)
  }

  function exitEditMode(id, { revert = true } = {}) {
    if (!editingCardIds.has(id)) return
    if (revert) restoreCardDraft(id)
    editingCardIds.delete(id)
    const card = cardEl(id)
    card?.classList.remove('is-editing', 'is-dirty')
    setCardStatus(id, '')
    syncCardDirtyState(id)
  }

  function enterEditMode(id) {
    for (const otherId of [...editingCardIds]) {
      if (otherId !== id) exitEditMode(otherId, { revert: true })
    }
    const card = cardEl(id)
    if (!card) return
    restoreCardDraft(id)
    editingCardIds.add(id)
    card.classList.add('is-editing')
    setCardStatus(id, '')
    syncCardDirtyState(id)
    card.querySelector('.tpl-card-edit .tpl-card-name-input')?.focus()
  }

  function syncAllCardDirtyStates() {
    templates.forEach((t) => syncCardDirtyState(t.id))
  }

  async function ensureApiReady() {
    let meta
    try {
      meta = await api.meta()
    } catch {
      throw new Error('无法连接后端 (端口 3003)。请执行 npm run dev:local 并刷新页面')
    }
    if (!Array.isArray(meta?.features)) {
      throw new Error('后端 API 响应异常（/api 可能被错误拦截）。请硬刷新页面 (Ctrl+Shift+R)，或重启 npm run dev:local')
    }
    if (!meta.features.includes('svg_templates')) {
      throw new Error('后端版本过旧，缺少 SVG 模板功能。请重启 npm run dev:server')
    }
    return meta
  }

  async function refreshList() {
    const res = await api.listTemplates()
    templates = res.templates || []
    editingCardIds.clear()

    if (templates.length === 0) {
      listEl.innerHTML = '<li class="templates-empty-item">暂无模板，请点击「上传 SVG」</li>'
      return
    }

    listEl.innerHTML = templates.map((t) => `
      <li class="tpl-grid-item">
        <article class="tpl-card" data-id="${t.id}">
          <div class="tpl-card-preview">
            <span class="tpl-card-thumb" data-thumb-id="${t.id}" aria-hidden="true"></span>
          </div>
          <div class="tpl-card-body">
            <div class="tpl-card-view">
              <div class="tpl-card-field">
                <span class="tpl-card-field-label">名称</span>
                <p class="tpl-card-name-display">${escapeHtml(t.name)}</p>
              </div>
              ${shouldShowGroupUi(options.user, accessGroups) ? `
                <div class="tpl-card-field tpl-card-group-field">
                  <span class="tpl-card-field-label">所属组</span>
                  <p class="tpl-card-group-display">${escapeHtml(groupNameById(accessGroups, t.group_id))}</p>
                </div>
              ` : ''}
              <div class="tpl-card-meta-row">
                <span class="tpl-card-meta">${formatBytes(t.svg_bytes || 0)}</span>
              </div>
              <div class="tpl-card-actions">
                <button type="button" class="button button-sm tpl-card-start-edit" data-id="${t.id}">修改</button>
                <button type="button" class="button button-sm tpl-card-replace" data-id="${t.id}">替换 SVG</button>
                <button type="button" class="button button-sm tpl-card-delete" data-id="${t.id}">删除</button>
              </div>
            </div>
            <div class="tpl-card-edit">
              <label class="tpl-card-field" for="tpl-name-${t.id}">
                <span class="tpl-card-field-label">名称</span>
                <input
                  type="text"
                  id="tpl-name-${t.id}"
                  class="tpl-card-name-input"
                  data-template-id="${t.id}"
                  value="${escapeAttr(t.name)}"
                  maxlength="120"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="模板名称"
                />
              </label>
              ${shouldShowGroupUi(options.user, accessGroups) ? `
                <div class="tpl-card-field tpl-card-group-field">
                  ${renderCardGroupField(t)}
                </div>
              ` : ''}
              <div class="tpl-card-actions">
                <button type="button" class="button button-sm button-primary tpl-card-save" data-id="${t.id}" disabled>保存</button>
                <button type="button" class="button button-sm tpl-card-cancel" data-id="${t.id}">取消</button>
              </div>
            </div>
            <p class="tpl-card-status" aria-live="polite"></p>
          </div>
        </article>
      </li>
    `).join('')

    await Promise.all(
      templates.map(async (t) => {
        const slot = listEl.querySelector(`[data-thumb-id="${t.id}"]`)
        if (!slot) return
        try {
          const svg = await getTemplateSvg(t.id)
          if (!mountIsolatedSvgPreview(slot, svg)) {
            unmountIsolatedSvgPreview(slot)
            slot.innerHTML = '<span class="tpl-thumb-fallback">预览失败</span>'
          }
        } catch {
          unmountIsolatedSvgPreview(slot)
          slot.innerHTML = '<span class="tpl-thumb-fallback">预览失败</span>'
        }
      }),
    )

    syncAllCardDirtyStates()
  }

  async function saveCard(id) {
    const t = templates.find((x) => x.id === id)
    const draft = readCardDraft(id)
    if (!t || !draft) return

    if (!draft.name) {
      setCardStatus(id, '名称不能为空', true)
      return
    }
    if (!isCardDirty(id)) return

    savingCardIds.add(id)
    syncCardDirtyState(id)
    setCardStatus(id, '正在保存…')

    const payload = { name: draft.name }
    if (shouldShowGroupUi(options.user, accessGroups) && draft.groupId != null) {
      payload.group_id = draft.groupId
    }

    try {
      await api.updateTemplate(id, payload)
      t.name = draft.name
      if (payload.group_id != null) t.group_id = payload.group_id
      updateCardViewDisplay(id)
      exitEditMode(id, { revert: false })
      setCardStatus(id, '已保存')
      options.onChange?.()
    } catch (err) {
      setCardStatus(id, err.message || '保存失败', true)
      syncCardDirtyState(id)
    } finally {
      savingCardIds.delete(id)
      syncCardDirtyState(id)
    }
  }

  function bindListEvents() {
    if (listUiBound) return
    listUiBound = true

    listEl.addEventListener('input', (e) => {
      const input = e.target.closest('.tpl-card-name-input')
      if (!input) return
      const id = Number(input.dataset.templateId)
      if (!editingCardIds.has(id)) return
      syncCardDirtyState(id)
      setCardStatus(id, '')
    })

    listEl.addEventListener('change', (e) => {
      const sel = e.target
      if (sel instanceof HTMLSelectElement && sel.id.startsWith('tpl-group-')) {
        const id = Number(sel.id.slice('tpl-group-'.length))
        if (!editingCardIds.has(id)) return
        syncCardDirtyState(id)
        setCardStatus(id, '')
      }
    })

    listEl.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.tpl-card-start-edit')
      if (editBtn) {
        e.preventDefault()
        enterEditMode(Number(editBtn.dataset.id))
        return
      }
      const cancelBtn = e.target.closest('.tpl-card-cancel')
      if (cancelBtn) {
        e.preventDefault()
        exitEditMode(Number(cancelBtn.dataset.id), { revert: true })
        return
      }
      const saveBtn = e.target.closest('.tpl-card-save')
      if (saveBtn) {
        e.preventDefault()
        void saveCard(Number(saveBtn.dataset.id))
        return
      }
      const replaceBtn = e.target.closest('.tpl-card-replace')
      if (replaceBtn) {
        e.preventDefault()
        replaceTargetId = Number(replaceBtn.dataset.id)
        replaceFileInput?.click()
        return
      }
      const deleteBtn = e.target.closest('.tpl-card-delete')
      if (deleteBtn) {
        e.preventDefault()
        void deleteTemplate(Number(deleteBtn.dataset.id))
      }
    })
  }

  async function deleteTemplate(id) {
    if (!window.confirm('确定删除此模板？')) return
    try {
      await api.deleteTemplate(id)
      svgCache.delete(id)
      invalidateSvgTemplateCache(id)
      await refreshList()
      options.onChange?.()
    } catch (err) {
      const refs = err.data?.references
      if (Array.isArray(refs) && refs.length) {
        const detail = refs
          .filter((g) => g.blocksDelete)
          .map((g) => {
            const names = (g.items || []).slice(0, 8).map((i) => `#${i.id} ${i.name || ''}`.trim()).join('、')
            const suffix = g.count > 8 ? ` 等共 ${g.count} 条` : ''
            return `${g.label}：${names}${suffix}`
          })
          .join('\n')
        alert([err.message || '删除失败', detail].filter(Boolean).join('\n\n'))
      } else {
        alert(err.message || '删除失败')
      }
    }
  }

  async function readSvgFile(file) {
    const text = await file.text()
    if (!text.includes('<svg')) throw new Error('不是有效的 SVG 文件')
    return text
  }

  uploadFileInput?.addEventListener('change', () => {
    const file = uploadFileInput.files?.[0]
    if (!file || uploadNameInput?.value.trim()) return
    uploadNameInput.value = file.name.replace(/\.svg$/i, '') || '新模板'
  })

  uploadForm?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const file = uploadFileInput?.files?.[0]
    if (!file) {
      setUploadFormStatus('请选择 SVG 文件', true)
      return
    }
    const name = (uploadNameInput?.value || file.name.replace(/\.svg$/i, '') || '新模板').trim()
    if (!name) {
      setUploadFormStatus('请填写模板名称', true)
      return
    }
    setUploadFormStatus('正在上传…')
    try {
      await readSvgFile(file)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('name', name)
      const groupId = readGroupSelectValue(container, 'tpl-upload-group', accessGroups, options.user)
      if (groupId) formData.append('group_id', String(groupId))
      const { id } = await api.uploadTemplateFile(formData)
      invalidateSvgTemplateCache(id)
      showUploadForm(false)
      await refreshList()
      options.onChange?.()
    } catch (err) {
      setUploadFormStatus(err.message || '上传失败', true)
    }
  })

  container.querySelector('#tpl-new')?.addEventListener('click', () => {
    showUploadForm(uploadFormWrap?.hidden !== false)
  })

  container.querySelector('#tpl-upload-cancel')?.addEventListener('click', () => {
    showUploadForm(false)
  })

  replaceFileInput?.addEventListener('change', async () => {
    const file = replaceFileInput.files?.[0]
    replaceFileInput.value = ''
    const id = replaceTargetId
    replaceTargetId = null
    if (!file || !id) return
    try {
      await readSvgFile(file)
      const existing = templates.find((t) => t.id === id)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('name', existing?.name || file.name.replace(/\.svg$/i, '') || '未命名模板')
      await api.replaceTemplateFile(id, formData)
      svgCache.delete(id)
      invalidateSvgTemplateCache(id)
      await refreshList()
      setCardStatus(id, 'SVG 已替换')
      options.onChange?.()
    } catch (err) {
      alert(err.message || '替换失败')
    }
  })

  /** 移除旧版 innerHTML 注入的内联 SVG（避免 .st0 等样式污染编辑页预览） */
  function removeLegacyInlineSvgs() {
    listEl.querySelectorAll('.tpl-card-thumb svg').forEach((svg) => svg.remove())
  }

  return {
    removeLegacyInlineSvgs,
    async init() {
      try {
        await ensureApiReady()
        accessGroups = await loadAccessibleGroups(true)
        bindListEvents()
        await refreshList()
      } catch (err) {
        console.error(err)
        showListError(err.message || '加载模板列表失败')
      }
    },
    async repaint() {
      try {
        await ensureApiReady()
        accessGroups = await loadAccessibleGroups(true)
        await refreshList()
      } catch (err) {
        console.error(err)
        showListError(err.message || '加载模板列表失败')
      }
    },
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

if (document.body?.classList.contains('templates-page-standalone')) {
  const next = new URL('/admin.html', window.location.origin)
  next.searchParams.set('view', 'templates')
  window.location.replace(next.pathname + next.search)
}
