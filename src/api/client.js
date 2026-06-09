const API_BASE = ''

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })
  let data = {}
  const text = await res.text().catch(() => '')
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = {}
  }
  if (path.startsWith('/api/') && /^\s*<!DOCTYPE/i.test(text)) {
    const err = new Error('API 请求返回了 HTML 而非 JSON（/api 代理异常）。请重启 npm run dev:local 并硬刷新页面')
    err.status = res.status
    throw err
  }
  if (!res.ok) {
    let msg = data.error || (text && text.length < 200 ? text : '') || res.statusText || '请求失败'
    if (path.startsWith('/api/') && /^\s*<!DOCTYPE/i.test(text)) {
      msg = 'API 请求返回了 HTML 而非 JSON（/api 代理异常）。请重启 npm run dev:local 并硬刷新页面'
    }
    if (res.status === 500 && !data.error) {
      msg = '后端内部错误：请查看运行 npm run dev 的终端日志；若 API 未启动，先执行 npm run dev:local'
    }
    if (res.status === 403 && data.error?.includes('未完成安装')) {
      msg = data.error
    }
    if (res.status === 502 || res.status === 503) {
      msg = '无法连接后端 (端口 3003)，请先 npm run dev:local 或 node server/index.js'
    }
    if (res.status === 404 && path.startsWith('/api/templates')) {
      msg = '模板接口不存在 (404)。请停止旧的后端进程后重新运行 npm run dev:server 或 npm start'
    }
    if (res.status === 404 && path.includes('/api/settings/fonts')) {
      msg =
        '字体设置接口 404：3003 端口可能是旧进程。本地请 netstat/taskkill 释放 3003 后执行 npm run dev:local；服务器请更新 server/ 并 pm2 restart cat。可运行 npm run check:api 自检'
    }
    if (res.status === 404 && path.includes('/api/media/upload')) {
      msg =
        '图片上传接口 404：3003 端口可能是旧版后端。请停止当前 dev 后重新运行 npm run dev:local（会自动结束旧进程），或执行 node scripts/kill-stale-api.mjs 后 npm run dev:server'
    }
    if (res.status === 404 && path.includes('/api/presets/') && path.endsWith('/group')) {
      msg = '布局模板所属组接口 404：3003 端口可能是旧进程。请 Ctrl+C 后执行 npm run dev:local（或 node scripts/kill-stale-api.mjs 后 npm run dev:server）'
    }
    if (res.status === 404 && path.includes('/api/maintenance/auto-backup')) {
      msg =
        '自动备份接口 404：3003 端口可能是旧版后端。请 Ctrl+C 后执行 npm run dev:local，或 node scripts/kill-stale-api.mjs 后 npm run dev:server'
    }
    if (res.status === 404 && path.includes('/api/auth/profile')) {
      msg =
        '账户中心接口 404：3003 端口可能是旧版后端。请 Ctrl+C 后执行 npm run dev:local，或 node scripts/kill-stale-api.mjs 后 npm run dev:server'
    }
    if (res.status === 404 && path.includes('/api/settings/fonts/upload')) {
      msg =
        '字体上传接口 404：请重启后端（npm run dev:local）。本地字体将保存到 public/font/ 并以 /font/文件名 访问'
    }
    const err = new Error(msg)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function uploadRequest(path, formData) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })
  let data = {}
  const text = await res.text().catch(() => '')
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = {}
  }
  if (!res.ok) {
    let msg = data.error || res.statusText || '上传失败'
    if (res.status === 404 && path.includes('/api/media/upload')) {
      msg =
        '图片上传接口 404：请重启后端（npm run dev:local 或 node scripts/kill-stale-api.mjs 后 npm run dev:server）'
    }
    const err = new Error(msg)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

/** @param {(evt: object) => void} onProgress @param {() => Promise<object>} runRequest */
function runWithBackupProgressPoll(onProgress, runRequest) {
  return new Promise((resolve, reject) => {
    let stopped = false
    let progressPolling = true
    /** @type {ReturnType<typeof setInterval> | null} */
    let timer = null
    /** @type {ReturnType<typeof setInterval> | null} */
    let simulateTimer = null
    let simulatedPct = 8
    let simulatedFull = false

    const startSimulatedProgress = (full = false) => {
      if (simulateTimer) return
      simulatedFull = full
      onProgress?.({
        stage: 'db',
        pct: simulatedPct,
        detail: full
          ? '正在创建全量备份…（重启 npm run dev:local 后可显示逐步进度）'
          : '正在创建数据备份…（重启 npm run dev:local 后可显示逐步进度）',
      })
      simulateTimer = setInterval(() => {
        simulatedPct = Math.min(94, simulatedPct + 1.5 + Math.random() * 2)
        onProgress?.({
          stage: simulatedPct > 70 ? 'compress' : 'db',
          pct: Math.round(simulatedPct),
          detail: simulatedFull ? '正在打包与压缩，请稍候…' : '正在导出数据库，请稍候…',
        })
      }, 450)
    }

    const poll = async () => {
      if (stopped || !progressPolling) return
      try {
        const res = await fetch(`${API_BASE}/api/maintenance/backup-progress`, { credentials: 'include' })
        if (res.status === 404) {
          progressPolling = false
          startSimulatedProgress(simulatedFull)
          return
        }
        if (!res.ok) return
        const data = await res.json()
        const p = data.progress
        if (p?.mode === 'full') simulatedFull = true
        if (p && (p.active || p.stage)) onProgress?.(p)
      } catch {
        // 轮询失败时忽略
      }
    }

    timer = setInterval(poll, 200)
    poll()

    runRequest()
      .then((result) => {
        stopped = true
        progressPolling = false
        if (timer) clearInterval(timer)
        if (simulateTimer) clearInterval(simulateTimer)
        onProgress?.({ stage: 'done', pct: 100, detail: result.filename ? `已生成 ${result.filename}` : '备份完成' })
        resolve(result)
      })
      .catch((err) => {
        stopped = true
        progressPolling = false
        if (timer) clearInterval(timer)
        if (simulateTimer) clearInterval(simulateTimer)
        reject(err)
      })
  })
}

/** @param {(evt: object) => void} onProgress @param {() => Promise<object>} runRequest */
function runWithRestoreProgressPoll(onProgress, runRequest) {
  return new Promise((resolve, reject) => {
    let stopped = false
    /** @type {ReturnType<typeof setInterval> | null} */
    let timer = null

    const poll = async () => {
      if (stopped) return
      try {
        const res = await fetch(`${API_BASE}/api/maintenance/restore-progress`, { credentials: 'include' })
        if (!res.ok) return
        const data = await res.json()
        const p = data.progress
        if (p && (p.active || p.stage)) onProgress?.(p)
      } catch {
        // 轮询失败时忽略
      }
    }

    timer = setInterval(poll, 200)
    poll()

    runRequest()
      .then((result) => {
        stopped = true
        if (timer) clearInterval(timer)
        onProgress?.({ stage: 'done', pct: 100, detail: result.message || '恢复完成' })
        resolve(result)
      })
      .catch((err) => {
        stopped = true
        if (timer) clearInterval(timer)
        onProgress?.({ stage: 'error', pct: 0, detail: err.message || '恢复失败' })
        reject(err)
      })
  })
}

export const api = {
  health: () => request('/api/health'),
  me: () => request('/api/auth/me'),
  login: (username, password) => request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  getProfile: () => request('/api/auth/profile'),
  updateProfile: (body) => request('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),

  listGroups: () => request('/api/groups'),
  createGroup: (body) => request('/api/groups', { method: 'POST', body: JSON.stringify(body) }),
  updateGroup: (id, body) => request(`/api/groups/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteGroup: (id, mergeIntoId = null) => request(`/api/groups/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ merge_into_id: mergeIntoId }),
  }),
  mergeGroups: (fromId, intoId) => request(`/api/groups/${fromId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ into_id: intoId }),
  }),
  listGroupMergeHistory: () => request('/api/groups/merge-history'),
  revertGroupMerge: (logId) => request(`/api/groups/merge-history/${logId}/revert`, { method: 'POST' }),

  listUsers: () => request('/api/users'),
  createUser: (body) => request('/api/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id, body) => request(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),

  listVisitorUsers: () => request('/api/visitor-users'),
  createVisitorUser: (body) => request('/api/visitor-users', { method: 'POST', body: JSON.stringify(body) }),
  updateVisitorUser: (id, body) => request(`/api/visitor-users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteVisitorUser: (id) => request(`/api/visitor-users/${id}`, { method: 'DELETE' }),

  publicLogin: (username, password) => request('/api/public/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }),
  publicLogout: () => request('/api/public/auth/logout', { method: 'POST' }),
  publicMe: () => request('/api/public/auth/me'),
  getPublicProfile: () => request('/api/public/auth/profile'),
  updatePublicProfile: (body) => request('/api/public/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),

  listPresets: () => request('/api/presets'),
  getPreset: (id) => request(`/api/presets/${id}`),
  createPreset: (body) => request('/api/presets', { method: 'POST', body: JSON.stringify(body) }),
  updatePreset: (id, body) => request(`/api/presets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  updatePresetGroup: async (id, groupId) => {
    const body = JSON.stringify({ group_id: groupId })
    const groupPath = `/api/presets/${id}/group`
    for (const method of ['POST', 'PUT', 'PATCH']) {
      try {
        return await request(groupPath, { method, body })
      } catch (err) {
        if (err.status !== 404 && err.status !== 405) throw err
      }
    }
    return request(`/api/presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ group_id: groupId, record_revision: false }),
    })
  },
  deletePreset: (id) => request(`/api/presets/${id}`, { method: 'DELETE' }),
  reorderPresets: (ids) => request('/api/presets/reorder', { method: 'PUT', body: JSON.stringify({ ids }) }),
  listPresetRevisions: (id) => request(`/api/presets/${id}/revisions`),
  restorePresetRevision: (id, revId) => request(`/api/presets/${id}/revisions/${revId}/restore`, { method: 'POST' }),

  listTemplates: () => request('/api/templates'),
  getTemplate: (id) => request(`/api/templates/${id}`),
  getTemplateFile: async (id) => {
    const res = await fetch(`${API_BASE}/api/templates/${id}/file`, {
      credentials: 'include',
      cache: 'no-store',
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      let msg = text && text.length < 200 ? text : res.statusText || '加载 SVG 失败'
      try {
        const data = JSON.parse(text)
        if (data.error) msg = data.error
      } catch { /* ignore */ }
      const err = new Error(msg)
      err.status = res.status
      throw err
    }
    return text
  },
  /** @param {FormData} formData */
  uploadTemplateFile: async (formData) => {
    const res = await fetch(`${API_BASE}/api/templates`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })
    const text = await res.text().catch(() => '')
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = {} }
    if (!res.ok) {
      const err = new Error(data.error || text || res.statusText || '上传失败')
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  },
  /** @param {number} id @param {FormData} formData */
  replaceTemplateFile: async (id, formData) => {
    const res = await fetch(`${API_BASE}/api/templates/${id}`, {
      method: 'PUT',
      credentials: 'include',
      body: formData,
    })
    const text = await res.text().catch(() => '')
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = {} }
    if (!res.ok) {
      const err = new Error(data.error || text || res.statusText || '替换失败')
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  },
  createTemplate: (body) => request('/api/templates', { method: 'POST', body: JSON.stringify(body) }),
  updateTemplate: (id, body) => request(`/api/templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTemplate: (id) => request(`/api/templates/${id}`, { method: 'DELETE' }),

  listTableTemplates: () => request('/api/table-templates'),
  getTableTemplate: (id) => request(`/api/table-templates/${id}`),
  createTableTemplate: (body) => request('/api/table-templates', { method: 'POST', body: JSON.stringify(body) }),
  updateTableTemplate: (id, body) => request(`/api/table-templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTableTemplate: (id) => request(`/api/table-templates/${id}`, { method: 'DELETE' }),

  listCertificates: (status = 'all') => request(`/api/certificates?status=${encodeURIComponent(status)}`),
  getCertificate: (id) => request(`/api/certificates/${id}`),
  checkPublicCertSlug: (slug, { groupId, excludeId } = {}) => {
    const q = new URLSearchParams({ slug: slug ?? '' })
    if (groupId != null) q.set('group_id', String(groupId))
    if (excludeId != null) q.set('exclude_id', String(excludeId))
    return request(`/api/certificates/public-slug/check?${q}`)
  },
  createCertificate: (body) => request('/api/certificates', { method: 'POST', body: JSON.stringify(body) }),
  updateCertificate: (id, body) => request(`/api/certificates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  publishCertificate: (id) => request(`/api/certificates/${id}/publish`, { method: 'POST' }),
  unpublishCertificate: (id) => request(`/api/certificates/${id}/unpublish`, { method: 'POST' }),
  deleteCertificate: (id) => request(`/api/certificates/${id}`, { method: 'DELETE' }),
  purgeCertificate: (id) => request(`/api/certificates/${id}?permanent=1`, { method: 'DELETE' }),
  restoreCertificate: (id) => request(`/api/certificates/${id}/restore`, { method: 'POST' }),
  batchDeleteCertificates: (ids) => request('/api/certificates/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),
  batchRestoreCertificates: (ids) => request('/api/certificates/batch-restore', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),
  batchPurgeCertificates: (ids) => request('/api/certificates/batch-purge', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),
  duplicateCertificate: (id, body = {}) => request(`/api/certificates/${id}/duplicate`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  batchDuplicateCertificates: (ids) => request('/api/certificates/batch-duplicate', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),
  listCertificateRevisions: (id) => request(`/api/certificates/${id}/revisions`),
  getCertificateRevision: (id, revId) => request(`/api/certificates/${id}/revisions/${revId}`),
  restoreCertificateRevision: (id, revId) => request(`/api/certificates/${id}/revisions/${revId}/restore`, { method: 'POST' }),

  listPublicCertificates: () => request('/api/public/certificates'),
  getPublicCertificate: (id) => request(`/api/public/certificates/${id}`),
  resolvePublicCertificateBySlug: (slug) => request(`/api/public/certificates/by-slug/${encodeURIComponent(slug)}`),
  getPublicCertificateRenderSnapshot: (id) => request(`/api/public/certificates/${id}/render-snapshot`),

  meta: () => request('/api/meta'),

  getPublicFontConfig: () => request('/api/public/font-config'),
  getPublicSiteConfig: (groupId) => {
    const q = groupId != null ? `?group_id=${encodeURIComponent(String(groupId))}` : ''
    return request(`/api/public/site-config${q}`)
  },
  getFontSettings: () => request('/api/settings/fonts'),
  updateFontSettings: (body) => request('/api/settings/fonts', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  getSiteSettings: (groupId) => {
    const q = groupId != null ? `?group_id=${encodeURIComponent(String(groupId))}` : ''
    return request(`/api/settings/site${q}`)
  },
  updateSiteSettings: (body) => request('/api/settings/site', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  listLocalFontFiles: () => request('/api/settings/fonts/local-files'),

  browseFontFiles: (path = 'public/font') => request(
    `/api/settings/fonts/browse?path=${encodeURIComponent(path)}`,
  ),

  testFontUrl: (url) => request('/api/settings/fonts/test', {
    method: 'POST',
    body: JSON.stringify({ url }),
  }),

  /** @param {File | Blob} file */
  uploadFont: (file, filename) => {
    const form = new FormData()
    const name = filename || (file instanceof File ? file.name : 'font.ttf')
    form.append('file', file, name)
    return uploadRequest('/api/settings/fonts/upload', form)
  },

  /** @param {File | Blob} file */
  uploadMedia: (file, filename) => {
    const form = new FormData()
    const name = filename || (file instanceof File ? file.name : 'image.png')
    form.append('file', file, name)
    return uploadRequest('/api/media/upload', form)
  },
  uploadPublicMedia: (file, filename) => {
    const form = new FormData()
    const name = filename || (file instanceof File ? file.name : 'image.png')
    form.append('file', file, name)
    return uploadRequest('/api/public/media/upload', form)
  },

  exportSvgTemplatesZip: async () => {
    const res = await fetch(`${API_BASE}/api/export/svg-templates`, { credentials: 'include' })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      let msg = '导出失败'
      try {
        const data = text ? JSON.parse(text) : {}
        msg = data.error || msg
      } catch {
        if (text && text.length < 200) msg = text
      }
      throw new Error(msg)
    }
    const cd = res.headers.get('Content-Disposition') || ''
    const m = cd.match(/filename="([^"]+)"/)
    const filename = m?.[1] || `svg-templates-${new Date().toISOString().slice(0, 10)}.zip`
    return { blob: await res.blob(), filename }
  },
  importSvgTemplatesZip: (file, onConflict = 'rename') => {
    const form = new FormData()
    form.append('file', file, file.name || 'svg-templates.zip')
    form.append('on_conflict', onConflict)
    return uploadRequest('/api/import/svg-templates', form)
  },
  exportTableTemplates: (ids) => {
    const q = ids?.length ? `?ids=${ids.join(',')}` : ''
    return request(`/api/export/table-templates${q}`)
  },
  importTableTemplates: (bundle, onConflict = 'rename') => request('/api/import/table-templates', {
    method: 'POST',
    body: JSON.stringify({ bundle, on_conflict: onConflict }),
  }),

  exportLayoutPresets: (ids) => {
    const q = ids?.length ? `?ids=${ids.join(',')}` : ''
    return request(`/api/export/layout-presets${q}`)
  },
  importLayoutPresets: (bundle, onConflict = 'rename') => request('/api/import/layout-presets', {
    method: 'POST',
    body: JSON.stringify({ bundle, on_conflict: onConflict }),
  }),

  exportCertificates: (ids) => {
    const q = ids?.length ? `?ids=${ids.join(',')}` : ''
    return request(`/api/export/certificates${q}`)
  },
  importCertificates: (bundle, onConflict = 'rename') => request('/api/import/certificates', {
    method: 'POST',
    body: JSON.stringify({ bundle, on_conflict: onConflict }),
  }),

  getMaintenanceStorage: () => request('/api/maintenance/storage'),
  getDashboardOverview: () => request('/api/dashboard/overview'),
  createDatabaseBackup: (mode = 'data') => request('/api/maintenance/backup-database', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  }),
  getBackupProgress: () => request('/api/maintenance/backup-progress'),
  getRestoreProgress: () => request('/api/maintenance/restore-progress'),
  createDatabaseBackupWithProgress: (mode = 'data', onProgress) => runWithBackupProgressPoll(onProgress, () =>
    request('/api/maintenance/backup-database', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  ),
  runAutoBackupWithProgress: (form = {}, onProgress) => runWithBackupProgressPoll(onProgress, () =>
    request('/api/maintenance/auto-backup/run-now', {
      method: 'POST',
      body: JSON.stringify({
        backup_mode: form.backup_mode,
        backup_dir: form.backup_dir,
      }),
    }),
  ),
  restoreDatabase: (file) => {
    const form = new FormData()
    form.append('file', file, file.name || 'backup.db')
    return uploadRequest('/api/maintenance/restore-database', form)
  },
  restoreDatabaseWithProgress: (file, onProgress) => runWithRestoreProgressPoll(onProgress, () => {
    const form = new FormData()
    form.append('file', file, file.name || 'backup.db')
    onProgress?.({
      stage: 'validate',
      pct: 1,
      detail: `正在上传 ${file.name || 'backup.db'}…`,
    })
    return uploadRequest('/api/maintenance/restore-database', form)
  }),
  previewCleanupUploads: () => request('/api/maintenance/cleanup-uploads', {
    method: 'POST',
    body: JSON.stringify({ confirm: false }),
  }),
  cleanupUploads: (confirm = true) => request('/api/maintenance/cleanup-uploads', {
    method: 'POST',
    body: JSON.stringify({ confirm }),
  }),
  getAutoBackupConfig: () => request('/api/maintenance/auto-backup'),
  saveAutoBackupConfig: (body) => request('/api/maintenance/auto-backup', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  runAutoBackupNow: () => request('/api/maintenance/auto-backup/run-now', { method: 'POST', body: '{}' }),
}
