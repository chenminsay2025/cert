#!/usr/bin/env node
/**
 * 从备份 .db 恢复 data/cat.db
 * 用法：npm run restore:data -- data/backups/cat-backup-xxxx.db
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { openDatabase } from '../server/db.js'
import {
  restoreDatabaseFromFile,
} from '../server/dataMaintenance.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function resolveBackupArg() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('用法: npm run restore:data -- <备份文件路径>')
    process.exit(1)
  }
  const src = path.isAbsolute(arg) ? arg : path.join(root, arg)
  if (!fs.existsSync(src)) {
    console.error(`[restore] 找不到备份文件: ${src}`)
    process.exit(1)
  }
  return src
}

function killApiPort() {
  const port = Number(process.env.API_PORT || 3003)
  if (process.platform !== 'win32') {
    try {
      execSync(`lsof -ti :${port} | xargs -r kill -9`, { stdio: 'ignore', shell: true })
    } catch {
      // ignore
    }
    return
  }
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
      console.log(`[restore] 已结束占用 ${port} 的 API 进程 PID ${pid}`)
    } catch {
      // ignore
    }
  }
}

async function main() {
  const src = resolveBackupArg()
  killApiPort()
  const db = openDatabase()
  try {
    const result = await restoreDatabaseFromFile(db, root, src)
    const counts = result.counts
    console.log(`[restore] 恢复后: 证书 ${counts.certificates} · SVG ${counts.svg_templates} · 表格模板 ${counts.table_templates}`)
    console.log(`[restore] 恢复前备份: data/backups/${result.safety_backup}`)
    console.log('[restore] 完成。请执行 npm run dev:local 或 npm start 重新启动')
  } catch (err) {
    console.error('[restore] 失败:', err.message)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[restore] 失败:', err.message)
  process.exit(1)
})
