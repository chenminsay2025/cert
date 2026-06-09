import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { envPath, markInstalled, projectRoot } from './installState.js'

/** @type {{ step: string, message: string, running: boolean, error: string | null, log: string[] }} */
export const installProgress = {
  step: 'idle',
  message: '',
  running: false,
  error: null,
  log: [],
}

function pushLog(line) {
  installProgress.log.push(line)
  if (installProgress.log.length > 200) installProgress.log.shift()
}

function setStep(step, message) {
  installProgress.step = step
  installProgress.message = message
  pushLog(`[${step}] ${message}`)
}

export function getNodeVersion() {
  const major = Number(process.versions.node.split('.')[0])
  return { version: process.versions.node, ok: major >= 18 }
}

export function normalizeSiteUrl(input) {
  let url = String(input || '').trim()
  if (!url) throw new Error('请填写网站地址')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  url = url.replace(/\/+$/, '')
  try {
    const u = new URL(url)
    if (!u.hostname) throw new Error('网址无效')
    return u.origin
  } catch {
    throw new Error('网址格式不正确，例如：https://cat.meituyin.cn')
  }
}

export function generateJwtSecret() {
  return crypto.randomBytes(48).toString('base64url')
}

export function writeEnvFile({
  siteUrl,
  adminUsername,
  adminPassword,
  port = 3003,
  jwtSecret = generateJwtSecret(),
}) {
  const lines = [
    '# 由安装程序自动生成',
    `PORT=${port}`,
    'NODE_ENV=production',
    `JWT_SECRET=${jwtSecret}`,
    `ADMIN_USERNAME=${adminUsername}`,
    `ADMIN_PASSWORD=${adminPassword}`,
    `CORS_ORIGIN=${siteUrl}`,
    '',
  ]
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8')
  return jwtSecret
}

export function upsertAdminUser(db, username, password) {
  const hash = bcrypt.hashSync(password, 10)
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT id FROM admin_user WHERE username = ?').get(username)
  if (existing) {
    db.prepare('UPDATE admin_user SET password_hash = ? WHERE id = ?').run(hash, existing.id)
    return
  }
  const any = db.prepare('SELECT id FROM admin_user LIMIT 1').get()
  if (any) {
    db.prepare('UPDATE admin_user SET username = ?, password_hash = ? WHERE id = ?').run(username, hash, any.id)
    return
  }
  db.prepare(
    'INSERT INTO admin_user (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
  ).run(username, hash, 'super_admin', now)
}

/** PM2 等场景下 PATH 可能不含 npm，使用与当前 Node 同目录的可执行文件 */
function resolveNpmCommand() {
  const binDir = path.dirname(process.execPath)
  const npm = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  return fs.existsSync(npm) ? npm : 'npm'
}

function hasPrebuiltDist() {
  return fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))
}

function viteCliPath() {
  return path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
}

function permissionHint() {
  return (
    'node_modules 目录权限不足（EACCES）。PM2 通常以 www 用户运行，请在 SSH 执行：\n' +
    `  chown -R www:www ${projectRoot}\n` +
    '然后重试安装；若发布包已含 dist/，上传最新 server/installRunner.js 后可跳过 npm 构建。'
  )
}

function failFromCommand(command, args, code) {
  const logText = installProgress.log.join('\n')
  if (logText.includes('EACCES') || logText.includes('permission denied')) {
    throw new Error(permissionHint())
  }
  const cmd = [path.basename(command), ...args].join(' ')
  if (code === 127 && /vite/.test(logText)) {
    throw new Error(
      '未找到 vite（多为 devDependencies 未安装）。请在 SSH 执行：\n' +
      `  cd ${projectRoot}\n` +
      '  NODE_ENV=development npm install --include=dev\n' +
      '或修复目录权限后重试安装。',
    )
  }
  throw new Error(`${cmd} 退出码 ${code}`)
}

function runCommand(command, args, label, { env } = {}) {
  return new Promise((resolve, reject) => {
    setStep(label, '执行中…')
    const isWin = process.platform === 'win32'
    const proc = spawn(command, args, {
      cwd: projectRoot,
      shell: isWin,
      env: { ...process.env, ...env },
    })
    proc.stdout?.on('data', (buf) => pushLog(String(buf).trim()))
    proc.stderr?.on('data', (buf) => pushLog(String(buf).trim()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else {
        try {
          failFromCommand(command, args, code)
        } catch (err) {
          reject(err)
        }
      }
    })
  })
}

async function installDepsAndBuild(npm) {
  await runCommand(npm, ['install', '--include=dev'], 'npm', {
    env: { NODE_ENV: 'development', NPM_CONFIG_PRODUCTION: 'false' },
  })
  setStep('build', '构建前端…')
  const viteCli = viteCliPath()
  if (fs.existsSync(viteCli)) {
    await runCommand(process.execPath, [viteCli, 'build'], 'build')
  } else {
    await runCommand(npm, ['run', 'build'], 'build')
  }
}

export function writeDeployHints(siteUrl, port) {
  const dir = path.join(projectRoot, '安装步骤')
  fs.mkdirSync(dir, { recursive: true })
  const nginx = `# 宝塔 → 网站 → 设置 → 配置文件 → 在 server { } 内加入：

location / {
    proxy_pass http://127.0.0.1:${port};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
`
  fs.writeFileSync(path.join(dir, 'nginx-baota.conf'), nginx, 'utf8')
  fs.writeFileSync(path.join(dir, '安装完成.txt'), `
猫咪血统证书 — 安装完成

网站地址：${siteUrl}
Node 端口：${port}（仅本机，勿对外开放）

宝塔建议：
1. 网站已绑定域名并开启 HTTPS
2. 反向代理到 http://127.0.0.1:${port}
3. PM2 守护：pm2 start server/index.js --name cat-svg && pm2 save

管理端：${siteUrl}/login.html
公众页：${siteUrl}/

请备份 data/cat.db
`.trim(), 'utf8')
}

export async function runInstall({ db, siteUrl, adminUsername, adminPassword, port = 3003 }) {
  if (installProgress.running) {
    throw new Error('安装正在进行中')
  }

  installProgress.running = true
  installProgress.error = null
  installProgress.log = []

  try {
    const node = getNodeVersion()
    if (!node.ok) throw new Error(`需要 Node.js ≥ 18，当前 ${node.version}`)

    const origin = normalizeSiteUrl(siteUrl)
    const user = String(adminUsername || 'admin').trim() || 'admin'
    const pass = String(adminPassword || '')
    if (pass.length < 6) throw new Error('管理员密码至少 6 位')

    setStep('env', '写入配置…')
    const jwtSecret = writeEnvFile({
      siteUrl: origin,
      adminUsername: user,
      adminPassword: pass,
      port,
    })

    // 发布包已含 dist 时不再跑 npm（避免 root/www 混用导致 node_modules EACCES）
    if (hasPrebuiltDist()) {
      setStep('npm', '发布包已含 dist，跳过 npm install 与构建')
    } else {
      const npm = resolveNpmCommand()
      setStep('npm', '安装依赖（首次约 1～3 分钟）…')
      await installDepsAndBuild(npm)
    }

    setStep('admin', '创建管理员…')
    upsertAdminUser(db, user, pass)

    writeDeployHints(origin, port)
    markInstalled({ siteUrl: origin, port })

    setStep('done', '安装完成，请重启 Node 进程')
    return { siteUrl: origin, port, jwtSecret }
  } catch (err) {
    installProgress.error = err.message || String(err)
    setStep('error', installProgress.error)
    throw err
  } finally {
    installProgress.running = false
  }
}

export function getInstallStatus() {
  const distDir = path.join(projectRoot, 'dist')
  return {
    node: getNodeVersion(),
    hasEnv: fs.existsSync(envPath),
    hasDist: fs.existsSync(distDir),
    progress: { ...installProgress, log: installProgress.log.slice(-30) },
  }
}
