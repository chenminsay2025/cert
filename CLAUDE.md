# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 语言要求

**始终使用中文进行对话。** 所有回复、解释、代码注释和文档使用中文。代码标识符（变量名、函数名）保持英文，但注释和沟通使用中文。

## 项目概述

猫咪血统证书生成器（Cat Pedigree Certificate Generator）— 单用户管理端 + 公众只读页的证书编辑与发布系统。

## 常用命令

```bash
npm run dev:local      # Windows 推荐 — 同时启动 API(:3003) + Vite(:5173)，自动结束旧进程
npm run dev            # 同时启动 API + Vite（Mac/Linux）
npm run dev:server     # 仅启动 API 服务器
npm run dev:web        # 仅启动 Vite 前端
npm run build          # 构建前端到 dist/（10 个入口页面）
npm start              # 生产环境运行 API（需先 build）
npm run reset:admin    # 重置管理员密码
npm run backup:data    # 备份数据库到 data/backups/
npm run check:api      # 检查 API 版本兼容性
```

**注意**：项目没有测试，但有 lint 和格式化命令。

```bash
npm run lint          # ESLint 检查
npm run lint:fix      # ESLint 自动修复
npm run format        # Prettier 格式化
npm run format:check  # Prettier 检查
```

## 技术架构

| 层 | 技术 |
|---|------|
| 前端 | Vite 6 + 原生 HTML/JS（无框架），多页面应用 |
| 后端 | Node.js + Hono 4（类 Express 的轻量框架） |
| 数据库 | better-sqlite3，WAL 模式，文件 `data/cat.db` |
| 认证 | JWT（jose 库），HttpOnly Cookie，7 天过期 |
| PDF | pdfkit.standalone.js（客户端生成） |
| Excel | xlsx 库 + Web Worker 解析 |
| 字体 | 七牛 CDN + 本地上传，fonteditor-core 处理 |
| 部署 | 宝塔面板 / PM2 / Nginx 反代 |

## 核心架构 — 两个巨石文件

项目经过快速迭代，两大核心文件承担了绝大部分逻辑，理解它们是理解整个项目的关键：

### `server/index.js`（约 2136 行）

整个 API 的路由、业务逻辑、数据库查询、工具函数全在一个文件中。虽然部分功能已抽出为独立模块（见下方"已拆分的服务端模块"），但证书 CRUD、布局预设 CRUD、SVG/表格模板 CRUD、修订记录仍在 index.js 中。

**该文件内的结构顺序**：
1. 导入 + 初始化（端口、密钥、CORS、数据库连接）
2. 数据库 schema 检查（启动时打印每列的 ready 状态）
3. 种子数据（管理员、默认 SVG 模板、字体设置）
4. 工具函数（`nowIso`、`parseJson`、`formatPresetRow`、`mergePresetFields` 等）
5. 路由：Auth → 布局预设 → SVG 模板 → 表格模板 → 证书 → 公众 API
6. 静态文件服务 + 启动

**数据库访问模式**：`db` 是通过 Proxy 包装的，支持 `reconnectDatabase()` 热重载。访问方式为 `db.prepare('SQL').all(...params)` 直接写在路由中。

**认证中间件链**：
```
requireAuth → 验证 JWT + 加载 principal（含 groupIds, moduleKeys）
requireSuperAdmin → 检查 isSuperAdmin
requireModule('xxx') → 检查模块权限
requireVisitorAuth → 访客或管理员 Cookie 均可
```

### `src/main.js`（约 3327 行）

编辑器核心，约 50+ 个模块级可变状态变量。管理表格编辑、SVG 预览渲染、编辑框布局、Excel 导入、PDF 导出等全部编辑器功能。

**关键全局状态**：
- `tableData` — 表格行数据
- `selectedRow` / `selectedCol` — 当前选中的单元格
- `layoutOverrides` — 编辑框位置/样式覆盖
- `templateSvg` / `templateId` — 当前 SVG 模板
- `columnOrder` — 列顺序
- `rowPresetIds` — 每行的布局模板 ID
- `fontCatalog` / `fontUrl` — 字体

**模块间通信**：通过 `window.__CAT_*__` 全局对象：
- `window.__CAT_CMS__` — CMS 栏控制器（证书管理、保存、模板切换）
- `window.__CAT_SPREADSHEET__` — 搜索功能对外接口
- `window.__CAT_PREVIEW_FLOAT__` — 预览浮窗控制器

## 已拆分的服务端模块

以下功能已经从 `server/index.js` 中独立：

| 文件 | 职责 |
|------|------|
| `server/db.js` | 数据库初始化、自动迁移（`ensureColumn`）、slug 工具 |
| `server/auth.js` | JWT 签名/验证、Cookie 管理、认证中间件、管理员种子 |
| `server/accessControl.js` | 访问组权限（groupIds）、`sqlGroupInClause` 构建、资源归属校验 |
| `server/resourceGuards.js` | 按组过滤获取单行资源 |
| `server/adminModules.js` | 管理端功能模块定义 |
| `server/siteSettings.js` | 站点名称/logo/品牌配置（按组） |
| `server/fontSettings.js` | 字体源配置 + 公开字体目录 |
| `server/mediaRoutes.js` | 图片上传，保存到 `public/uploads/` |
| `server/svgTemplateFiles.js` | SVG 模板文件读写（存磁盘而非 DB） |
| `server/svgTemplateRefs.js` | SVG 模板引用检测 + 级联删除清理 |
| `server/certificateTrash.js` | 证书回收站（软删除/恢复/永久删除） |
| `server/certificatePublicSlug.js` | 证书公开 URL slug 管理 |
| `server/certificateSearch.js` | 证书数据写入 search_text 字段 |
| `server/certificateRowPresets.js` | 证书行级布局模板校验 |
| `server/certificateAdornments.js` | 证书公开快照构建（模板 SVG + 修饰数据） |
| `server/certificateAccessGroup.js` | 证书与访问组的自动同步 |
| `server/tableTemplateColumnSync.js` | 表格模板列变更时同步更新关联的布局预设 |
| `server/autoBackup.js` | 定时自动备份（签名比对避免重复备份） |
| `server/dataMaintenance.js` | 备份/恢复执行、存储统计 |
| `server/dataTransfer.js` | 导入/导出（表模板、布局预设、证书、SVG 模板 zip） |
| `server/accountRoutes.js` | 管理员 + 访客账号管理 |
| `server/adminManageRoutes.js` | 访问组 CRUD、用户权限分配 |
| `server/dashboardRoutes.js` | 仪表盘统计 |
| `server/maintenanceRoutes.js` | 维护操作 API |
| `server/installRoutes.js` / `installRunner.js` / `installState.js` | Web 安装向导 |
| `server/groupsMigration.js` | 访问组功能的历史数据迁移 |
| `server/groupMerge.js` | 访问组合并与撤销 |
| `server/rateLimit.js` | 登录速率限制（内存版，5分钟/10次） |
| `src/lruCache.js` | LRU 缓存（SVG 预览行缓存，最多 12 条） |

## 数据库迁移机制

项目已升级为**版本化迁移系统**（`server/db.js` 的 `runMigrations()`）：
- `db.js` 的 `runMigrations()` 按版本号顺序执行迁移（`applyMigration(db, version, fn)`）
- 每个版本的迁移只执行一次，记录在 `migrations` 表中
- 已有数据库自动回填版本号（`backfillMigrationVersions()`），确保向后兼容
- `ensureColumn()` 仍保留，在迁移函数中通过 `PRAGMA table_info` 检查列

## 已拆分的路由模块

证书和公众页的路由已从 `server/index.js` 拆分到独立模块：

| 文件 | 职责 |
|------|------|
| `server/routes/certificates.js` | 证书 CRUD、发布/撤回、复制、回收站、修订历史 |
| `server/routes/public.js` | 公众页已发布证书浏览 API |

路由模块通过 `ctx` 共享上下文对象注入依赖（`db`, `nowIso`, `parseJson`, 中间件等）。

## 数据访问层

`server/repositories/` 目录包含 SQL 查询封装：

| 文件 | 职责 |
|------|------|
| `server/repositories/svgTemplateRepo.js` | SVG 模板查询/创建/更新/删除 |
| `server/repositories/certificateRepo.js` | 证书查询/创建/更新/发布/修订 |

## 前端页面入口

Vite 构建 10 个入口（`vite.config.js` 的 `rollupOptions.input`）：

| 入口 | 文件 | 用途 |
|------|------|------|
| main | `index.html` | 管理端主页（编辑器） |
| admin | `admin.html` | 管理端重定向入口 |
| login | `login.html` | 管理端登录页 |
| viewer | `viewer.html` | 公众浏览页 |
| templates | `templates.html` | SVG 模板管理页 |
| tableTemplates | `table-templates.html` | 表格模板管理页 |
| layoutPresets | `layout-presets.html` | 布局预设管理页 |
| fonts | `fonts.html` | 字体设置页 |
| install | `install.html` | Web 安装向导 |
| publicLogin | `public-login.html` | 公众页登录 |

每个页面独立加载对应的 JS 模块（如 `src/admin/templates.js`），共享 `src/` 下的通用模块。

## 关键设计模式

### 访问组（Access Groups）权限系统

所有资源（SVG 模板、表格模板、布局预设、证书）都归属 `access_groups`。管理员被分配到若干组，只能看到自己组的资源。核心机制：
- `sqlGroupInClause(principal)` → 生成 `AND group_id IN (?,?,?)` SQL 片段
- 超级管理员（super_admin）跳过组过滤，`sqlGroupInClause` 返回空 clause
- 资源创建时自动分配到用户所属组，`getUngroupedGroupId()` 提供默认"未分组"

### 布局预设 → 证书 的继承链

证书可以关联布局预设（`layout_presets`），布局预设定义：
- 编辑框布局覆盖（`layout_overrides`）
- 关联的 SVG 模板和表格模板
- 预览样例行（`preview_sample_row`）
- 编辑框默认值（`presetCustomSamples`）

证书行可以逐行覆盖布局预设（`rowPresetIds`）。

### 修订历史

两种修订系统：
1. **布局预设修订**（`layout_preset_revisions` 表）：保存 `v: 2` 格式的快照，最多 50 条
2. **证书修订**（`certificate_revisions` 表）：完整快照（含 rows），每次保存创建一条

### 编辑框布局存储

编辑框布局通过三条路径加载（优先级递减）：
1. 服务器端 CMS 数据（证书/预设中的 `layout_overrides`）
2. `layout-settings.json`（项目根目录 + `public/` 双份同步）
3. 浏览器 localStorage（旧版迁移）

Vite 开发模式下，`layout-settings.json` 的 GET/PUT 直接在 Vite 插件中处理（不经过后端）。

## 开发注意事项

- **必须先启动后端再启动前端**：Vite 代理 `/api`、`/uploads`、`/svg-templates`、`/font` 到 `localhost:3003`
- **3003 端口被占用**：运行 `npm run dev:local` 会自动 kill 旧进程；或手动 `node scripts/kill-stale-api.mjs`
- **前后端版本必须匹配**：Vite 启动后 1.5 秒会检查 `api/meta` 的 `features` 列表，缺失新接口会打印警告
- **修改 server/db.js 后**：需要重启后端才能生效；数据库没有自动迁移
- **添加新 API 路由时**：建议在 `features` 列表（`/api/meta` 返回）中添加对应 feature 名，这样前端可以检测兼容性
- **SVG 模板存磁盘**：`data/svg-templates/` 目录，数据库中只存 `file_path`，读取时从磁盘加载
- **Cookie 有两个**：管理端 `cat_session`，公众页 `cat_visitor_session`，两者可共存
- **生产部署需要 `NODE_ENV=production`**：这样 Cookie 才会带 `Secure` 标志
