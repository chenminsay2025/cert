#!/usr/bin/env node
/**
 * 打包服务器部署 zip（不含 node_modules、data/backups）
 * 用法：node scripts/pack-deploy.mjs [输出路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { openDatabase } from '../server/db.js'
import { createDatabaseBackup, formatBytes, maintenanceTimestamp } from '../server/dataMaintenance.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.cursor'])
const SKIP_REL_PREFIXES = [
  'data/backups/',
  'release/',
]
const SKIP_REL_EXACT = new Set([
  'data/cat.db-shm',
  'data/cat.db-wal',
  'data/cat000.db',
])
const SKIP_ROOT_FILES = /\.zip$/i

function shouldSkip(relPosix) {
  if (SKIP_REL_EXACT.has(relPosix)) return true
  if (SKIP_REL_PREFIXES.some((p) => relPosix === p.slice(0, -1) || relPosix.startsWith(p))) return true
  const parts = relPosix.split('/')
  if (parts.some((p) => SKIP_DIR_NAMES.has(p))) return true
  if (!relPosix.includes('/') && SKIP_ROOT_FILES.test(relPosix)) return true
  return false
}

/** @param {string} dir @param {string} [prefix] @returns {{ rel: string, abs: string }[]} */
function walk(dir, prefix = '') {
  /** @type {{ rel: string, abs: string }[]} */
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.gitkeep') continue
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name
    const relPosix = rel.replace(/\\/g, '/')
    if (shouldSkip(relPosix)) continue
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      out.push(...walk(abs, relPosix))
    } else if (ent.isFile()) {
      out.push({ rel: relPosix, abs })
    }
  }
  return out
}

async function snapshotDatabase() {
  const db = openDatabase()
  try {
    const tmpDir = path.join(root, 'data', '_pack-tmp')
    fs.mkdirSync(tmpDir, { recursive: true })
    const result = await createDatabaseBackup(db, root, tmpDir, {
      mode: 'data',
      filename: 'cat.db',
    })
    return result.path
  } finally {
    db.close()
  }
}

async function main() {
  const stamp = maintenanceTimestamp()
  const defaultOut = path.join(root, 'release', `Cat8-cert-meituyin-cn-${stamp}.zip`)
  const outPath = path.resolve(process.argv[2] || defaultOut)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  console.log('[pack] 正在合并 WAL 并快照数据库…')
  const dbSnapshot = await snapshotDatabase()

  const files = walk(root)
  const dbTarget = 'data/cat.db'
  const packFiles = files.filter((f) => f.rel !== dbTarget)

  console.log(`[pack] 打包 ${packFiles.length + 1} 个文件…`)
  const zip = new JSZip()
  zip.file('DEPLOY-README.txt', [
    'Cat8 部署包 — cert.meituyin.cn',
    '================================',
    '',
    `打包时间：${new Date().toISOString()}`,
    '',
    '【上传后】',
    '1. 宝塔解压到网站根目录（如 /www/wwwroot/cert.meituyin.cn）',
    '2. chown -R www:www .',
    '3. sudo -u www npm install',
    '4. 编辑 .env：',
    '   CORS_ORIGIN=https://cert.meituyin.cn',
    '   NODE_ENV=production',
    '5. PM2 启动 server/index.js 端口 3003',
    '6. Nginx 反代到 127.0.0.1:3003',
    '',
    '【已包含】dist/、data/cat.db、uploads/、svg-templates/、.env',
    '【未包含】node_modules/、data/backups/',
    '',
    '详细步骤：安装步骤/发布到服务器.md',
    '',
  ].join('\r\n'))

  zip.file(dbTarget, fs.readFileSync(dbSnapshot))
  let totalBytes = fs.statSync(dbSnapshot).size
  for (const { rel, abs } of packFiles) {
    const buf = fs.readFileSync(abs)
    zip.file(rel, buf)
    totalBytes += buf.length
  }

  console.log('[pack] 正在压缩 ZIP…')
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  }, (meta) => {
    if (Math.round(meta.percent) % 20 === 0) {
      process.stdout.write(`\r[pack] 压缩进度 ${Math.round(meta.percent)}%`)
    }
  })
  process.stdout.write('\n')

  fs.writeFileSync(outPath, buffer)
  try {
    fs.unlinkSync(dbSnapshot)
    fs.rmSync(path.dirname(dbSnapshot), { recursive: true, force: true })
  } catch {
    // ignore
  }

  console.log(`[pack] 完成 → ${outPath}`)
  console.log(`[pack] 大小 ${formatBytes(buffer.length)}（原始约 ${formatBytes(totalBytes)}）`)
}

main().catch((err) => {
  console.error('[pack] 失败:', err.message)
  process.exit(1)
})
