# 猫咪血统证书生成器

Vite 前端 + Node API（SQLite），支持单用户管理端与公众只读页。

## 功能

- **管理端**（`/`，需登录）：编辑表格数据、SVG 编辑框、导出 PDF；证书草稿/发布；布局预设命名与切换；修订记录恢复。
- **公众端**（`/viewer.html`）：仅浏览已发布证书，无编辑权限。
- **API**（`/api/*`）：会话 Cookie 鉴权，单管理员账号。

## 环境要求

- Node.js **≥ 18**

## 快速开始

本地开发详见 **[安装步骤/本地开发快速开始.md](安装步骤/本地开发快速开始.md)**。

```bash
cp .env.example .env
npm install
npm run dev:local   # Windows 推荐；其它系统可用 npm run dev
```

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 同时启动 API + Vite |
| `npm run dev:web` | 仅前端 |
| `npm run dev:server` | 仅 API |
| `npm run build` | 构建前端（含 login、viewer 页面） |
| `npm start` | 生产环境运行 API |

## 宝塔 / 服务器一键安装

**三步：上传解压 → 安装 → 反代**

详细说明见 [安装步骤/宝塔三步安装.txt](安装步骤/宝塔三步安装.txt)（完整版见 [安装步骤/发布到服务器.md](安装步骤/发布到服务器.md)）

### 方式 A：网页安装（推荐）

1. 宝塔添加网站，上传项目 zip 到网站目录并解压  
2. PM2 添加 Node 项目：启动文件 `server/index.js`，端口 `3003`  
3. 浏览器打开 `https://你的域名/install.html`，填写网址和管理员密码，点击安装  
4. 安装完成后 **重启 PM2**，Nginx 反代到 `127.0.0.1:3003`  

### 方式 B：命令行

```bash
cd /www/wwwroot/你的站点目录
bash install.sh
# 按提示输入 https://cat.meituyin.cn 和密码
pm2 start server/index.js --name cat-svg && pm2 save
```

安装程序会自动：`npm install` → `npm run build` → 写入 `.env` → 创建管理员。

---

## 安装与部署文档

所有安装、迁移、宝塔与服务器发布说明已整理至 **[安装步骤/](安装步骤/)** 目录。

## 数据说明

| 存储 | 内容 |
|------|------|
| `data/cat.db` | 用户、证书、表格行、布局预设、修订 |
| `layout-settings.json` | 本地开发时编辑框备份（可选，与 CMS 并存） |

首次启动会在数据库中创建管理员（若尚无用户），用户名/密码来自 `.env`。
