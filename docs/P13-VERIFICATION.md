# P13 工作台界面改版验证记录

日期：2026-11-28（Asia/Shanghai）。范围依据 [SPEC 第 14 节](SPEC.md#14-工作台界面改版2026-11-28已确认) 和 [OpenSpec 工作台改版](../openspec/changes/redesign-workspace/proposal.md)。

状态：界面实现、本地离线验证及代码、交互与视觉审查已完成；P14 在同一工作树补充真实 PostgreSQL/API 集成、API/Worker 浏览器回归、生产镜像构建、完整 Docker 恢复及镜像内 UI 验证。远程 CI、GHCR 发布与准确 digest 见[对应标签流水线](https://github.com/brucewar/tattoo/actions?query=branch%3Av0.1.0-rc.2)，OpenSpec 变更保持 active，不在此时归档。

## 实现范围

- React 和 Tiptap 保留，Ant Design 控件、依赖与专属样式迁移至项目内维护的 shadcn/ui、Radix 交互原语和 Tailwind 语义样式。
- Tailwind 构建工具归入开发依赖；Dockerfile 保留 shadcn/ui 上游许可证，部署结构不变。
- 管理页使用紧凑导航、统一列表与表单层级；加载失败和空数据分开，提供重新加载。字段校验关联输入，提交错误后聚焦可修正的字段。
- 浅色、深色和跟随系统均可选择，默认跟随系统；当前浏览器记住偏好，响应系统变化、无效值和存储拒绝，应用挂载前通过同源外部脚本初始化主题。
- 编辑器支持可收起的文章信息、专注写作、自动增高的多行标题和受限制的 Ctrl/Cmd+S；保存继续使用不可变修订，不增加自动保存。
- 弹窗采用 Radix 焦点管理，关闭后返回合理位置；微信预览保持白底深色正文，预览 iframe 的键盘关闭不放宽既有 sandbox 或 CSP。
- 未保存提醒、会话过期重登后的本地内容、密钥保留与清除、任务找回和显式投递约束继续保留。

## P13 本地已执行检查

| 检查               | 命令或范围                                                                                                               | 结果                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 干净依赖安装       | `npm ci --include=optional --no-audit --no-fund`                                                                         | 通过，退出码 0；补齐并检查跨平台原生可选依赖锁条目                         |
| TypeScript         | `npm run typecheck`                                                                                                      | 通过，退出码 0                                                             |
| 单元               | `npm test`                                                                                                               | 13 个文件、272 项通过                                                      |
| 生产构建           | `npm run build`；最终 `npm run build -w @tattoo/web`                                                                     | 通过，退出码 0；前端仍有单个 chunk 超过 500 kB 的构建提示                  |
| OpenSpec           | `npx --yes @fission-ai/openspec@1.13.2 validate redesign-workspace --strict`                                             | 通过，退出码 0，输出 `Change 'redesign-workspace' is valid`                |
| 管理表单浏览器     | [workspace-settings.spec.ts](../tests/e2e/workspace-settings.spec.ts)                                                    | 5 / 5 通过                                                                 |
| 工作台与摘要浏览器 | [workspace-ui.spec.ts](../tests/e2e/workspace-ui.spec.ts)、[article-digest.spec.ts](../tests/e2e/article-digest.spec.ts) | 11 / 11 通过（55.6 秒）                                                    |
| 布局与截图         | 桌面浅色/深色、编辑器、390px、长标题、专注与收起文章信息                                                                 | 8 种布局无页面横向溢出，0 JavaScript 错误，0 意外 API 请求；已目视检查截图 |

类型、单元、构建和 OpenSpec 的结果来自本次实际工具输出，没有为这些 stdout 声称不存在的归档日志。当前本地 Node.js 为 22.15；OpenSpec 2.2.0 的运行时要求不匹配，未以该版本执行验证，也未因此提高 Tattoo 的 Node.js 要求。严格规范校验使用上述兼容的 1.13.2 版本。

依赖锁已修复缺失的原生平台可选条目：11 个 Lightning CSS 平台条目完整，26 个 esbuild 平台元数据与原有锁一致；检查未发现缺失或精确版本不匹配，既有包版本未改变。随后在 Windows 完成上述干净安装；其结果与后续 Linux 容器构建分别记录，容器证据见下文追加回归。

工作台离线浏览器以系统分配的环回端口运行 Vite，关闭热更新，全部应用 API 由 fixtures 拦截；验证结束后关闭自有前端与浏览器，不启动数据库或 Worker。管理页的 5 项检查覆盖：模型协议与密钥、未保存配置、必填与 token 整数边界、公众号字段约束、四个管理区域的读取失败及恢复、URL/RSS 和搜索密钥清除。

工作台与摘要的 11 项检查覆盖三种外观、刷新记忆、系统变化、存储拒绝与无效值、应用未挂载时的主题初始化、登录外观、专注编辑和未保存保护、快捷保存及弹窗限制、会话过期重登、摘要长度边界和 390px 操作。微信预览另覆盖：初始焦点在关闭按钮，主动聚焦 iframe 后 Escape 关闭并返回预览触发按钮；历史修订预览同样可 Escape 返回历史弹窗，随后关闭历史并返回其触发按钮。两组离线浏览器共 16 项通过。

本地诊断产物位于被 Git 忽略的 `data/workspace-ui-results/`、`data/settings-ui-results/` 和 `data/ui-redesign-preview/`，供本次审查使用；它们不是克隆仓库后保证存在的公开文档附件。截图数据全部是明确隔离的演示 fixtures，不是用户的真实文章或账号数据。

## P14 同工作树追加回归

以下为账户安全实施时对同一工作树追加的回归证据，不改写上表中 P13 当时的 272 项单元和 16 项离线浏览器记录，详细结果见 [P14 验证记录](P14-VERIFICATION.md)。

- 全量单元 289 / 289、真实 PostgreSQL/API 集成 113 / 113 通过（10 个文件，含账户安全 19 项）；数据库为隔离原生 PostgreSQL 16.16，使用环回地址和专用测试库，未运行 Docker。
- 正式 API/Worker 浏览器入口第二轮 55 / 58 通过（10.2 分钟）。三个失败是 P6 协议文本匹配隐藏 option、P6 窄屏模型配置导航、P9 窄屏资料导航的旧 UI 选择器；等价修正后，通过同一正式入口复跑 P2/P6/P9 三个文件，13 / 13 通过（2.8 分钟，退出码 0）。全部 58 个独立用例在整轮与定点复跑中覆盖通过，不表示单次 58 / 58。
- 原有业务调用计数检查通过，固定测试草稿只创建一次，没有发表或群发调用；自有 API、Worker、Vite、schema 和临时素材目录已清理。微信、模型和搜索使用隔离模拟接口，不代表真实平台权限通过。
- 同一工作树的 TypeScript、生产构建、格式与账户安全 OpenSpec 严格校验也已通过；之后在 Docker 29.9.3、Compose 5.7.1 上完成 `linux/amd64` 生产镜像构建、`verify-foundation` 和真实 `pg_dump`/`pg_restore` 完整恢复，均退出码 0。TOTP 保留、防重放边界推进、旧一次性认证材料清理、旧任务冻结与重建持久化均通过，详细结果见 P14 验证记录。
- 生产镜像内额外 UI 验证通过：账户安全真实闭环 1 / 1（24.3 秒），浅色/深色/跟随系统、系统变化与刷新记忆通过；Manrope 实际 ready、字体响应 200，CSP 违规、字体失败、JavaScript 错误与外部请求均为 0。
- Docker 验证使用本轮隔离项目与临时配置，结束后清理自有容器、卷与临时目录，既有预览容器和旧 smoke 卷保留；额外 UI 项目容器与卷均为 0、临时目录已删除，原预览三容器 ID 不变。GHCR 发布证据独立于本地验证记录。

## 浏览器复现

先启动独立的 Vite 前端，再设置 `TATTOO_E2E_TEST_MODE=1` 与指向该前端的 `TATTOO_E2E_BASE_URL`，执行：

```bash
npx playwright test tests/e2e/workspace-ui.spec.ts tests/e2e/workspace-settings.spec.ts tests/e2e/article-digest.spec.ts
```

这三个文件使用离线 API fixtures，不需要真实服务凭据。首屏主题用例会阻断 Vite 的应用入口模块，以验证外部主题初始化不依赖 React 挂载，因此此处使用开发前端，不把生产 API/Worker 环境替换成 fixtures 后冒充完整验收。

## 未执行与交付边界

- 本地 Docker 生产构建、基础部署、重建持久化、完整恢复与生产 UI 已由上述 P14 同工作树证据补充；GHCR 推送、准确 digest 与拉取结果以对应标签流水线为准。
- 本轮未调用真实付费模型、Tavily 或微信公众号接口，未创建真实远程草稿。离线 UI 结果不能证明用户网络、模型参数、微信权限或出口 IP 白名单正确。
- 不因界面验证通过就宣称新的 GHCR 产物已发布或可拉取；镜像发布仍需对应提交的完整 CI、发布与拉回验收。
- P10 知乎和小红书导出、自动选题与周期生成仍不在本次实现范围。部署仍是 API、Worker、PostgreSQL 三个容器，远程写入开关及恢复规则不随界面迁移改变。

已将追加的 PostgreSQL、API/Worker 与本地 Docker 回归同步到 [OpenSpec 任务清单](../openspec/changes/redesign-workspace/tasks.md)。真实服务和远程发布证据仍分别记录，两项变更均保持 active。
