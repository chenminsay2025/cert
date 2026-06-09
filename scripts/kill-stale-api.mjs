#!/usr/bin/env node
/**
 * 开发启动前：若 3003 上是旧版 API（无 media_upload），结束占用端口的进程，
 * 以便 concurrently 能拉起带图片上传的新 server/index.js。
 */
import { execSync } from 'node:child_process'

const PORT = Number(process.env.API_PORT || 3003)
const META = `http://127.0.0.1:${PORT}/api/meta`
const PROFILE = `http://127.0.0.1:${PORT}/api/auth/profile`

const REQUIRED_FEATURES = [
  'media_upload',
  'table_template_sample_rows',
  'layout_preset_template_refs',
  'layout_preset_page_nav_column',
  'certificate_public_adornments',
  'auto_backup',
  'dashboard',
  'account_profile',
  'backup_full_zip',
  'cleanup_avatar_refs',
  'backup_progress',
]

const devMode = process.argv.includes('--dev')

/** Node 24 + Windows：AbortSignal.timeout 后立刻 process.exit 会触发 libuv 断言崩溃 */
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

async function isStaleApi() {
  try {
    const res = await fetchWithTimeout(META, 2500)
    if (!res.ok) return false
    const data = await res.json()
    const feats = data.features || []
    if (REQUIRED_FEATURES.some((f) => !feats.includes(f))) return true
  } catch {
    return false
  }
  try {
    const probe = await fetchWithTimeout(PROFILE, 2000)
    if (probe.status === 404) return true
  } catch {
    // ignore
  }
  return false
}

function killPortWindows(port) {
  let out = ''
  try {
    out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
  } catch {
    return
  }
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    const pid = parts[parts.length - 1]
    if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
      console.log(`[kill-stale-api] 已结束占用 ${port} 的旧进程 PID ${pid}`)
    } catch {
      // ignore
    }
  }
}

function killPortUnix(port) {
  try {
    execSync(`lsof -ti :${port} | xargs -r kill -9`, { stdio: 'ignore', shell: true })
    console.log(`[kill-stale-api] 已结束占用 ${port} 的进程`)
  } catch {
    // ignore
  }
}

async function isPortListening() {
  try {
    const res = await fetchWithTimeout(META, 1500)
    return res.ok
  } catch {
    return false
  }
}

function killPort() {
  if (process.platform === 'win32') killPortWindows(PORT)
  else killPortUnix(PORT)
}

if (devMode) {
  if (await isPortListening()) {
    console.warn(`[kill-stale-api] 开发模式：结束占用 ${PORT} 的 API，以便加载最新代码…`)
    killPort()
  }
} else {
  const stale = await isStaleApi()
  if (stale) {
    console.warn(`[kill-stale-api] ${PORT} 端口为旧版 API，正在结束旧进程…`)
    killPort()
  }
}
