#!/usr/bin/env node
/**
 * 命令行安装：在项目根目录执行 node server/install-cli.js
 * 或 bash install.sh
 */
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { openDatabase } from './db.js'
import { isInstalled } from './installState.js'
import { getInstallStatus, runInstall } from './installRunner.js'

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

async function promptDefaults(args) {
  const rl = readline.createInterface({ input, output })
  try {
    const siteUrl = args.url || args.siteUrl || await rl.question('网站地址（如 https://cat.meituyin.cn）: ')
    const adminUsername = args.user || args.admin || await rl.question('管理员用户名 [admin]: ') || 'admin'
    const adminPassword = args.password || args.pass || await rl.question('管理员密码（至少6位）: ')
    const portStr = args.port || await rl.question('Node 端口 [3003]: ') || '3003'
    return {
      siteUrl,
      adminUsername,
      adminPassword,
      port: Number(portStr) || 3003,
    }
  } finally {
    rl.close()
  }
}

async function main() {
  if (isInstalled()) {
    console.log('检测到已安装（data/.installed 存在）。')
    console.log('若要重装，请先删除 data/.installed 和 .env，再重新运行。')
    process.exit(0)
  }

  const st = getInstallStatus()
  if (!st.node.ok) {
    console.error(`需要 Node.js ≥ 18，当前 ${st.node.version}`)
    process.exit(1)
  }

  const args = parseArgs(process.argv.slice(2))
  const opts = await promptDefaults(args)

  console.log('\n开始安装，请稍候…\n')
  const db = openDatabase()
  try {
    const result = await runInstall({ db, ...opts })
    console.log('\n✓ 安装完成')
    console.log(`  网站：${result.siteUrl}`)
    console.log(`  登录：${result.siteUrl}/login.html`)
    console.log(`  公众页：${result.siteUrl}/`)
    console.log('\n下一步：')
    console.log('  1. 宝塔 PM2 启动/重启：pm2 start server/index.js --name cat-svg && pm2 save')
    console.log('  2. 网站反向代理到 http://127.0.0.1:' + result.port)
    console.log('  3. 详见 安装步骤/安装完成.txt 与 安装步骤/nginx-baota.conf')
  } catch (err) {
    console.error('\n安装失败：', err.message)
    process.exit(1)
  }
}

main()
