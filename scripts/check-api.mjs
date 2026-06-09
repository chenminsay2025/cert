#!/usr/bin/env node
/** 检查 3003 是否为当前版本 API（含 font_settings） */
const url = process.env.API_URL || 'http://127.0.0.1:3003/api/meta'

try {
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`[check-api] ${url} → HTTP ${res.status}`)
    console.error('请先启动: npm run dev  或  node server/index.js')
    process.exit(1)
  }
  const data = await res.json()
  if (!data.features?.includes('font_settings')) {
    console.error('[check-api] 3003 端口上是旧版后端（无 font_settings）')
    console.error('Windows: netstat -ano | findstr :3003  然后 taskkill /PID <pid> /F')
    console.error('再执行: npm run dev:local')
    process.exit(1)
  }
  if (!data.features?.includes('media_upload')) {
    console.error('[check-api] 3003 端口上是旧版后端（无 /api/media/upload 图片上传）')
    console.error('请执行: node scripts/kill-stale-api.mjs  然后  npm run dev:local')
    process.exit(1)
  }
  if (!data.features?.includes('layout_preset_template_refs')) {
    console.error('[check-api] 3003 端口上是旧版后端（布局预设无法保存 SVG/表格模板选择）')
    console.error('请执行: node scripts/kill-stale-api.mjs  然后  npm run dev:local')
    process.exit(1)
  }
  if (!data.features?.includes('layout_preset_group')) {
    console.error('[check-api] 3003 端口上是旧版后端（布局模板所属组无法保存）')
    console.error('请执行: node scripts/kill-stale-api.mjs  然后  npm run dev:local')
    process.exit(1)
  }
  console.log('[check-api] OK，字体、图片上传与布局预设模板关联可用')
} catch (err) {
  console.error('[check-api] 无法连接', url, '-', err.message)
  console.error('请先 npm run dev:local')
  process.exit(1)
}
