# P9 资料获取验证记录

日期：2026-11-24（Asia/Shanghai）。依据用户继续实施 P9 并选择 Tavily 的决定，范围见 [SPEC 第 11 节](SPEC.md#11-p9-资料获取2026-11-24)，操作见 [资料说明](SOURCES.md)，官方接口和库依据见 [调研记录](SOURCES-RESEARCH.md)。

## 验证对象

公开 URL 正文、RSS/Atom 手动订阅拉取、Tavily 配置/搜索及明确采集、资料到 AI 的固定快照。采集任务独立于生成和投递，继续使用 PostgreSQL 和一个 Worker；没有新增 Redis、定时生成、评分或日报。

## 执行入口

```bash
npm run build
npm test
npm run test:integration
node tests/e2e/run-p2.mjs
npm run format:check

docker compose build
node scripts/verify-foundation.mjs
npm run verify:recovery
```

专用数据库与浏览器环境见 [开发说明](DEVELOPMENT.md)。模拟服务同源提供 HTML/RSS/Atom/Tavily 响应，并与真实 API、Worker、PostgreSQL 交互；不配置或调用真实付费服务。

## 已执行与待执行

- Node 22.15.0 实际 CommonJS `require('jsdom')`、DOM 构造和 Readability 正文提取通过，未仅凭 engines 声明判断兼容。
- Prisma 生成、共享契约、Server 与 Web 构建通过。
- 完整单元 245 / 245 通过，含 Reader 14 项、Tavily 25 项及测试例外不能进入生产的配置检查。
- 完整 PostgreSQL 集成 86 / 86 通过，含 AI 29 项和 Sources 14 项，验证实际 HTTP 采集、搜索、去重、执行权及来源快照。
- 本机 P9 四项浏览器流程均已通过，覆盖链接/RSS、搜索到 AI、断线复用与存储拒绝、390px 窄屏。最终定点 3 / 3（P2 测试草稿、AI 图文闭环、收费搜索保护）脚本正常结束；完整 24 项浏览器由同一提交的 CI 复核，链接随交付说明提供。
- Docker 正式镜像构建、四服务基础验收和扩展备份恢复全部通过；配置错误/缺密钥/重复 Worker 拒启，重建持久化及恢复隔离保持有效。
- 旧 schema 中预先保存模型与历史任务，再应用协议和资料迁移的定点回归通过：密钥、版本和结果保留，历史任务资料引用默认空数组，新增表初始为空。
- 已修复跨 500 UTF-16 单元的 emoji 标题截断问题；真实 HTML/RSS 回归覆盖文章、订阅和条目标题。

Docker 首次干净安装发现锁文件缺少 esbuild 的平台依赖，未把宿主已有 node_modules 下的构建成功当作跨平台验证；在隔离目录修复锁文件并重新执行正式镜像检查。浏览器检查运行期间不重装其运行依赖。

锁文件通过与镜像一致的 Node 22.23.5 / npm 10.9.9 补齐 26 个 esbuild 可选平台条目；原有条目及版本完全保留。修复前同一 Docker npm 的 clean-install dry-run 失败，修复后干净安装及正式镜像构建通过。

首轮 13 项浏览器 12 通过，Ant Design 的透明退出图标污染搜索按钮的可访问名称；为动作添加稳定的 `aria-label`。下一轮 8 项中，测试在填写搜索词前断言按钮可用，空词按规则禁用；调整操作顺序后定点 3 项通过，实际验证存储拒绝时零 POST、零额外搜索，未放宽超时或强制点击。

公开 URL 运行烟测使用编译后的受限 Reader，对 `https://aihot.news/about` 成功提取标题和 840 字符正文；未存入数据库，也未调用搜索或模型。重建后的本地 Docker 预览登录、资料页面/API 和三种文本协议选项均通过只读浏览器检查，未创建采集、搜索或生成任务。

扩展恢复实际保存加密 Tavily 配置、订阅、资料正文及五种旧搜索任务；停源 Worker 后才准备数据。恢复确认三类密钥解密、旧会话失效、正文/订阅/AI 快照完整、旧排队/运行任务冻结且终态保持，重建后再次检查一致；隔离资源正常清理。实际应用镜像为 `sha256:0982d1cd0cc251b617f614cc8b38377bba411b1e633e644423cd0b19ffab7131`。

本机 Docker 已由用户切换或重置，之前的预览容器、数据库卷及镜像不在当前环境，主机上的配置和图片仍在。当前引擎为 Docker Desktop 29.9.3 Linux/x86_64；隔离测试库重新建立。重建预览不等同于恢复旧文章、账号或模型配置，原数据库内容需旧卷或备份才能恢复。

`npm audit` 当前报告既有 Prisma、Sharp、Vitest/Tinypool、Zod 等依赖告警，修复建议涉及原有核心依赖的大版本升级；本次新增解析依赖没有出现在该报告中。此项未作为“无漏洞检查通过”交付，也未运行会改动核心架构的强制升级。

真实 Tavily、模型和微信公众号验收未在本轮执行，不能用模拟响应或保存配置替代。
