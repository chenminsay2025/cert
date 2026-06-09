import fs from 'node:fs'
import path from 'node:path'
import { isInstalled, projectRoot } from './installState.js'
import { getInstallStatus, installProgress, runInstall } from './installRunner.js'

/**
 * @param {import('hono').Hono} app
 * @param {{ db: import('better-sqlite3').Database }} deps
 */
export function registerInstallRoutes(app, { db }) {
  app.get('/api/install/status', (c) => {
    return c.json({
      installed: isInstalled(),
      ...getInstallStatus(),
    })
  })

  app.post('/api/install/run', async (c) => {
    if (isInstalled()) {
      return c.json({ error: '已完成安装，如需重装请删除 data/.installed 后重试' }, 400)
    }
    if (installProgress.running) {
      return c.json({ error: '安装正在进行中' }, 409)
    }

    const body = await c.req.json().catch(() => ({}))
    try {
      const result = await runInstall({
        db,
        siteUrl: body.siteUrl,
        adminUsername: body.adminUsername,
        adminPassword: body.adminPassword,
        port: Number(body.port) || 3003,
      })
      return c.json({
        ok: true,
        siteUrl: result.siteUrl,
        port: result.port,
        message: '安装完成。请在宝塔 PM2 中重启本项目，然后访问登录页。',
        loginUrl: `${result.siteUrl}/login.html`,
      })
    } catch (err) {
      return c.json({ error: err.message || '安装失败' }, 500)
    }
  })

  app.get('/install.html', (c) => {
    if (isInstalled()) return c.redirect('/login.html')
    const file = path.join(projectRoot, 'install.html')
    if (!fs.existsSync(file)) return c.text('缺少 install.html', 500)
    return c.html(fs.readFileSync(file, 'utf8'))
  })

  app.get('/install', (c) => c.redirect('/install.html'))
}
