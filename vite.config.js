import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPseudoStaticCertPathname } from './src/publicCertUrl.js'
import {
  isAdminLoginPathname,
  isBlockedDefaultAdminLoginPathname,
  DEFAULT_ADMIN_LOGIN_SLUG,
} from './src/adminLoginPath.js'
import {
  isPublicLoginPathname,
  isBlockedDefaultPublicLoginPathname,
  DEFAULT_PUBLIC_LOGIN_SLUG,
} from './src/publicLoginPath.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const layoutSettingsRoot = path.join(__dirname, 'layout-settings.json')
/** 对外提供 GET；PUT 时与根目录同步，便于在 IDE 中查看 */
export const layoutSettingsPath = path.join(__dirname, 'public', 'layout-settings.json')

const defaultLayoutBakedPath = path.join(__dirname, 'src', 'default-layout-settings.json')

function getDefaultLayoutBody() {
  if (fs.existsSync(defaultLayoutBakedPath)) {
    const data = JSON.parse(fs.readFileSync(defaultLayoutBakedPath, 'utf8'))
    return JSON.stringify({ ...data, updatedAt: null }, null, 2)
  }
  return JSON.stringify({
    v: 4,
    updatedAt: null,
    fontScale: 1,
    showLayoutBoxes: false,
    layoutOverrides: {},
  }, null, 2)
}

function ensureLayoutSettingsFile() {
  const publicDir = path.dirname(layoutSettingsPath)
  fs.mkdirSync(publicDir, { recursive: true })
  if (fs.existsSync(layoutSettingsPath)) return
  if (fs.existsSync(layoutSettingsRoot)) {
    fs.copyFileSync(layoutSettingsRoot, layoutSettingsPath)
    return
  }
  fs.writeFileSync(layoutSettingsPath, getDefaultLayoutBody(), 'utf8')
}

function readLayoutSettingsFile() {
  ensureLayoutSettingsFile()
  if (fs.existsSync(layoutSettingsPath)) {
    return fs.readFileSync(layoutSettingsPath, 'utf8')
  }
  if (fs.existsSync(layoutSettingsRoot)) {
    return fs.readFileSync(layoutSettingsRoot, 'utf8')
  }
  return null
}

function writeLayoutSettingsFile(body) {
  JSON.parse(body)
  ensureLayoutSettingsFile()
  fs.writeFileSync(layoutSettingsPath, body, 'utf8')
  fs.writeFileSync(layoutSettingsRoot, body, 'utf8')
}

export default defineConfig({
  plugins: [
    {
      name: 'layout-settings-api',
      enforce: 'pre',
      configureServer(server) {
        const warnStaleApi = async () => {
          try {
            const res = await fetch('http://127.0.0.1:3003/api/meta', {
              signal: AbortSignal.timeout(2000),
            })
            if (!res.ok) return
            const data = await res.json()
            if (
              !data.features?.includes('media_upload')
              || !data.features?.includes('table_template_sample_rows')
              || !data.features?.includes('layout_preset_template_refs')
              || !data.features?.includes('certificate_public_adornments')
              || !data.features?.includes('auto_backup')
              || !data.features?.includes('account_profile')
              || !data.features?.includes('backup_full_zip')
              || !data.features?.includes('cleanup_avatar_refs')
              || !data.features?.includes('backup_progress')
            ) {
              server.config.logger.warn(
                '[CAT] 3003 为旧版 API（缺少备份进度等接口）。请 Ctrl+C 后执行 npm run dev:local（会自动结束旧进程）',
              )
            }
            try {
              const profileRes = await fetch('http://127.0.0.1:3003/api/auth/profile', {
                signal: AbortSignal.timeout(1500),
              })
              if (profileRes.status === 404) {
                server.config.logger.warn(
                  '[CAT] /api/auth/profile 不存在，请 node scripts/kill-stale-api.mjs 后重新 npm run dev:local',
                )
              }
            } catch {
              // ignore
            }
          } catch {
            server.config.logger.warn(
              '[CAT] 未连接后端 :3003，请先 npm run dev:local（同时启动 API 与 Vite）',
            )
          }
        }
        setTimeout(() => { void warnStaleApi() }, 1500)

        let cachedAdminLoginSlug = DEFAULT_ADMIN_LOGIN_SLUG
        let cachedPublicLoginSlug = DEFAULT_PUBLIC_LOGIN_SLUG
        let adminLoginSlugFetchedAt = 0
        const refreshLoginSlugs = async (force = false) => {
          const now = Date.now()
          if (!force && now - adminLoginSlugFetchedAt < 5000) return
          try {
            const res = await fetch('http://127.0.0.1:3003/api/meta', {
              signal: AbortSignal.timeout(2000),
            })
            if (!res.ok) return
            const data = await res.json()
            cachedAdminLoginSlug = data.adminLoginPath || DEFAULT_ADMIN_LOGIN_SLUG
            cachedPublicLoginSlug = data.publicLoginPath || DEFAULT_PUBLIC_LOGIN_SLUG
            adminLoginSlugFetchedAt = now
          } catch {
            // API 未就绪时保持默认
          }
        }
        void refreshLoginSlugs(true)
        setInterval(() => { void refreshLoginSlugs() }, 10000)

        server.middlewares.use((req, res, next) => {
          const pathname = req.url?.split('?')[0] || ''
          if (pathname.startsWith('/api/') || pathname === '/api') return next()
          if (isBlockedDefaultAdminLoginPathname(cachedAdminLoginSlug, pathname)) {
            res.statusCode = 404
            res.end('Not Found')
            return
          }
          if (isBlockedDefaultPublicLoginPathname(cachedPublicLoginSlug, pathname)) {
            res.statusCode = 404
            res.end('Not Found')
            return
          }
          if (isAdminLoginPathname(cachedAdminLoginSlug, pathname)) {
            const q = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
            req.url = `/login.html${q}`
          } else if (isPublicLoginPathname(cachedPublicLoginSlug, pathname)) {
            const q = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
            req.url = `/public-login.html${q}`
          }
          next()
        })

        server.middlewares.use((req, res, next) => {
          const pathname = req.url?.split('?')[0] || ''
          if (pathname.startsWith('/api/') || pathname === '/api') return next()
          if (req.method === 'GET' && isPseudoStaticCertPathname(pathname)) {
            req.url = '/index.html'
          }
          next()
        })

        server.middlewares.use((req, res, next) => {
          const url = req.url?.split('?')[0]
          if (url === '/default-layout-settings.json') {
            if (req.method === 'GET') {
              try {
                const body = fs.existsSync(defaultLayoutBakedPath)
                  ? fs.readFileSync(defaultLayoutBakedPath, 'utf8')
                  : getDefaultLayoutBody()
                res.statusCode = 200
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.setHeader('Cache-Control', 'no-store')
                res.end(body)
              } catch (err) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: String(err.message || err) }))
              }
              return
            }
            if (req.method === 'PUT') {
              let body = ''
              req.on('data', (chunk) => { body += chunk })
              req.on('end', () => {
                try {
                  const data = JSON.parse(body)
                  const normalized = JSON.stringify({
                    v: 4,
                    fontScale: data.fontScale ?? 1,
                    showLayoutBoxes: !!data.showLayoutBoxes,
                    layoutOverrides: data.layoutOverrides && typeof data.layoutOverrides === 'object'
                      ? data.layoutOverrides
                      : {},
                  }, null, 2)
                  fs.mkdirSync(path.dirname(defaultLayoutBakedPath), { recursive: true })
                  fs.writeFileSync(defaultLayoutBakedPath, normalized, 'utf8')
                  res.statusCode = 200
                  res.setHeader('Content-Type', 'application/json')
                  res.end('{"ok":true}')
                } catch (err) {
                  res.statusCode = 400
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ error: String(err.message || err) }))
                }
              })
              return
            }
            next()
            return
          }

          if (url !== '/layout-settings.json') {
            next()
            return
          }

          if (req.method === 'GET') {
            try {
              const body = readLayoutSettingsFile()
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.setHeader('Cache-Control', 'no-store')
              res.end(body || getDefaultLayoutBody())
            } catch (err) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: String(err.message || err) }))
            }
            return
          }

          if (req.method === 'PUT') {
            let body = ''
            req.on('data', (chunk) => { body += chunk })
            req.on('end', () => {
              try {
                writeLayoutSettingsFile(body)
                res.statusCode = 200
                res.setHeader('Content-Type', 'application/json')
                res.end('{"ok":true}')
              } catch (err) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: String(err.message || err) }))
              }
            })
            return
          }

          next()
        })
      },
    },
    {
      name: 'copy-layout-settings-to-dist',
      closeBundle() {
        const distPath = path.join(__dirname, 'dist', 'layout-settings.json')
        const body = readLayoutSettingsFile()
        fs.mkdirSync(path.dirname(distPath), { recursive: true })
        fs.writeFileSync(distPath, body || getDefaultLayoutBody(), 'utf8')
      },
    },
  ],
  server: {
    port: 5173,
    open: '/',
    proxy: {
      '/api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
      '/svg-templates': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
      '/font': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: path.join(__dirname, 'index.html'),
        admin: path.join(__dirname, 'admin.html'),
        login: path.join(__dirname, 'login.html'),
        viewer: path.join(__dirname, 'viewer.html'),
        templates: path.join(__dirname, 'templates.html'),
        tableTemplates: path.join(__dirname, 'table-templates.html'),
        layoutPresets: path.join(__dirname, 'layout-presets.html'),
        fonts: path.join(__dirname, 'fonts.html'),
        install: path.join(__dirname, 'install.html'),
        publicLogin: path.join(__dirname, 'public-login.html'),
      },
    },
  },
})
