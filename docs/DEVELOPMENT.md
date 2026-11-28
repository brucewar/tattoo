# 本地开发与工程验证

需要 Node.js 22（至少 22.15）、npm 10/11，以及运行 Linux 容器的 Docker Compose。以下命令均在仓库根目录执行。

```bash
npm ci
npm run setup
npm run typecheck
npm test
npm run build
```

`setup` 生成被 Git 忽略的 `.env`，不覆盖已有文件。请在本机查看并修改配置；不要复制凭证到 Issue 或聊天。仓库没有开发机绝对路径要求。

在宿主机运行开发服务器时，将 `.env` 中的 `APP_ORIGIN` 改为 `http://localhost:5173`，然后执行：

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres
npm run db:deploy
npm run dev
```

开发覆盖文件只把 PostgreSQL 映射到宿主环回地址的 55433 端口，不用于 NAS 正式部署。

## 前端组件与外观

工作台采用 React、TypeScript、项目内维护的 shadcn/ui 组件、Tailwind 和 Tiptap。基础控件与应用封装集中维护，不重新引入 Ant Design 或另一套全局主题。管理页保持紧凑的信息层级，文章正文保持适合阅读的宽度；新增控件需同时检查浅色、深色、键盘和窄屏状态。

“外观主题”提供浅色、深色和跟随系统，偏好只保存在当前浏览器的 `tattoo:theme`，不写入服务器配置或数据库。默认跟随系统，存储不可用时仍可继续使用。根主题在应用挂载前通过同源外部脚本初始化，不放宽 `script-src 'self'`。微信预览的浅色阅读画布独立于工作台主题，不随切换修改文章或导出排版。详细变更依据见 [OpenSpec 设计](../openspec/changes/redesign-workspace/design.md)。

## 独立数据库集成测试

```bash
docker compose -f compose.test.yaml up -d --wait
```

将 `TEST_DATABASE_URL` 设置为 `postgresql://tattoo:tattoo_test@127.0.0.1:55432/tattoo_test`，然后运行 `npm run test:integration`。PowerShell 使用 `$env:TEST_DATABASE_URL = '...'`；bash 使用 `export TEST_DATABASE_URL='...'`。该入口先应用版本化迁移，再在真实 PostgreSQL 中验证约束。测试只允许名称包含 `test` 的独立数据库，不连接生产库。测试配置使用明确的环回地址，避免 Windows 下 localhost 优先解析到 IPv6 而容器只映射 IPv4。

测试完成后运行 `docker compose -f compose.test.yaml down`。测试库使用 tmpfs，容器删除即丢弃测试数据；主应用的持久卷不会受影响。

真实 API 测试使用 `TEST_BIND_LOOPBACK=true` 将测试进程限制为 `127.0.0.1`。该选项默认关闭，仅允许 `NODE_ENV=test`，其他环境启用会拒绝启动；Docker 和正式部署继续使用默认监听方式。也可在隔离原生 PostgreSQL 上执行集成测试，但仍须使用专用测试库与随机 schema，并分别记录数据库回归和 Docker 部署结果。

## Docker 部署骨架

```bash
npm run setup
export TATTOO_IMAGE=tattoo-app:local
docker compose -f compose.yaml -f compose.build.yaml config --quiet
docker compose -f compose.yaml -f compose.build.yaml build api
docker compose -f compose.yaml -f compose.build.yaml up -d --no-build --remove-orphans --wait
```

PowerShell 将上面的 `export` 改为 `$env:TATTOO_IMAGE = 'tattoo-app:local'`。构建、部署与后续两个隔离验证脚本应使用相同的本地镜像引用，不依赖配置生成器中的发布版本标签。

配置文件已存在时跳过 `setup`。默认访问 `http://localhost:8080`；局域网访问需将 `.env` 的 `APP_ORIGIN` 改为实际访问来源，包括端口。前端构建包含在单一应用镜像内，由 API 提供；API 与 Worker 共享镜像，只有 API 对宿主开放 Web 端口。Compose 共 API、Worker、PostgreSQL 三个容器。API 在启动前执行 `prisma migrate deploy`，失败则不启动 HTTP 服务；Worker 等待 API 就绪后启动。数据库与图片使用命名卷。

默认 `compose.yaml` 从 GHCR 拉取固定版本，没有 `build`。源码开发需显式添加 `compose.build.yaml`；构建时不要设置指向远程 digest 的 `TATTOO_IMAGE`。只使用预构建镜像见[部署说明](DEPLOYMENT.md)。

当前已实现登录、账号设置、只读接口验证、固定测试草稿，以及文章编辑、修订、预览和普通文章草稿投递。模拟服务通过仍不能解释为真实微信权限通过。应用会固定读取仓库根目录的 `.env`，相对素材路径也以仓库根目录解析，因此从 workspace 启动 API/Worker 时与 Docker 的配置规则一致。

镜像构建完成后，在同一终端保留 `TATTOO_IMAGE` 再运行 `node scripts/verify-foundation.mjs` 执行隔离部署验证；脚本默认镜像为 `tattoo-app:local`，必须与实际构建引用一致。它创建随机 Compose 项目和环回端口，使用临时配置及合成凭据，不读取仓库根 `.env`，验证健康检查、启动失败门槛、Worker 互斥和容器重建持久化。结束后只清理本次自有容器、卷与临时目录，不保留测试卷，也不操作已有部署。

## 登录与公众号接入

首次启动前在本机 `.env` 中设置 `ADMIN_EMAIL`，使用生成的 `ADMIN_PASSWORD` 登录。已有管理员不会被后续启动覆盖，初始化完成后可以移除 `ADMIN_PASSWORD`。会话在退出、过期或密码重置后失效。

在“账号设置”添加 AppID 和 AppSecret。密钥仅通过本机页面提交，后端加密保存，后续读取不返回明文；编辑时留空表示保留原密钥。AppID 创建后不可修改，轮换 AppSecret 会清空 token 缓存和已验证能力。

“只读验证”仅获取 token 和草稿计数，不上传封面，不创建草稿，也不会将“新增草稿”标记为已验证。40164 时按微信报告的真实出口 IP 配置白名单。现行官方字段与图片规则已记录在 [微信核验记录](WECHAT-API.md)，实际账号权限仍需在用户环境验证。

## 显式创建测试草稿

1. 将 `.env` 中 `REMOTE_WRITES_ENABLED` 改为 `true`，执行 `docker compose -f compose.yaml -f compose.build.yaml up -d --force-recreate api worker` 使配置生效。
2. 在账号设置中选择公众号，上传 JPG/PNG 封面，确认将产生远程素材及草稿后发起测试。
3. 系统创建持久任务，Worker 在后台上传封面并创建固定测试文章；重复点击或网络重试沿用同一请求标识。
4. 在投递详情查看结果与远程 ID，并在微信后台确认草稿实际可见。测试素材与草稿由用户按需手动清理，系统不自动删除。

连接中断、无法解析响应或危险阶段的进程重启会进入“结果待核对”，不会自动重复提交。先执行 `docker compose -f compose.yaml -f compose.build.yaml stop worker` 并确认旧 Worker 已结束，再在微信后台检查。人工核对需填写说明、确认已停止 Worker；服务端同时检查全局执行权和账号锁。确认已创建可以没有远程 ID，但结果明确标为“人工确认”，不会冒充接口验证。确认未创建后另行显式重试，最后执行 `docker compose -f compose.yaml -f compose.build.yaml up -d worker`。

## 文章编辑与预览

登录后在“内容”新建或打开文章。可填写标题、作者、摘要、原文链接，上传正文图片和封面；不完整稿件也可以点击“保存文章”。每次内容变化生成新修订，无变化保存复用当前修订。支持 Ctrl/Cmd + S，首版没有自动保存。

保存冲突不会覆盖本地编辑。先复制需要保留的内容，再通过“加载最新修订”明确放弃当前编辑并重新载入。离开未保存内容时会提醒；会话过期后重新登录可以继续当前页面中的编辑，但关闭页面或崩溃后不能恢复尚未保存的内容。

“修订历史”只读展示已保存快照；“微信预览”对应明确的已保存修订，当前有修改时先保存。预览是一套固定公众号排版的近似效果，会提示缺少封面/正文或超过本地平台检查范围；最终排版还会在替换微信图片地址后再次校验。

外部富文本只接受声明支持的格式，字体和颜色采用统一排版。外链图片不会自动下载，请先保存到本地，再通过“正文图片”上传；不支持的结构会提示使用纯文本粘贴。图片粘贴和拖入每次处理一张，支持 JPG/PNG。

## 普通文章存入微信草稿

1. 在本机部署配置启用 `REMOTE_WRITES_ENABLED=true` 并重启 API/Worker，刷新页面使开关状态生效。
2. 保存文章后点击“存入微信草稿”，选择公众号，核对标题、修订号和保存时间。有未保存内容时先保存；完整性检查失败的稿件仍可本地保存。
3. 预检只读取本地账号、修订与素材，不调用微信。通过检查后，明确确认会上传素材并新增一篇远程草稿。
4. Worker 在后台准备独立 JPEG 上传副本，分别上传永久封面与正文图片，替换地址，重新检查最终 HTML，再创建草稿并记录远程 ID。排队后继续编辑不会改变本次任务。
5. 在投递详情或记录页查看结果。同一账号、修订和动作返回原任务，成功后不会再次创建；保存新修订后可以另建草稿，微信中的旧草稿仍保留。

确定失败可在原任务上显式重试。结果待核对时按上面的停 Worker、检查微信后台和记录人工结论流程处理，不能盲目重复提交。网络中断后先取回原目标的记录，系统不会自动换账号或悄悄使用最新修订。首版不自动清理远程素材或草稿。

微信上传副本会按大小缩放、转为白底 JPEG，规范化的本地原素材保持不变。现行字段规则及应用保守字符计量见微信核验记录；文章不会被自动截断来满足限制。

## 管理员密码恢复

运行容器内的 `scripts/reset-admin.mjs`，通过临时环境变量提供新密码。不要把密码作为命令行参数或提交到配置示例。PowerShell 示例：

```powershell
$tattooNewPassword = Read-Host '新管理员密码' -AsSecureString
$env:TATTOO_NEW_PASSWORD = [System.Net.NetworkCredential]::new('', $tattooNewPassword).Password
docker compose -f compose.yaml -f compose.build.yaml exec -T -e TATTOO_NEW_PASSWORD api node scripts/reset-admin.mjs
Remove-Item Env:TATTOO_NEW_PASSWORD
```

重置会原子撤销全部旧会话，并保留已启用的 TOTP；重复启动不会把密码改回初始配置。本地源码方式先构建后执行 `node scripts/reset-admin.mjs`，同样从环境变量读取新密码。网页改密、恢复码和明确移除 2FA 的部署应急操作见[账户安全](ACCOUNT-SECURITY.md)，其中包含无需 SSH 的群晖 Container Manager 终端步骤。

## 浏览器验证

数据库测试容器就绪且应用已构建后，设置与集成测试相同的 `TEST_DATABASE_URL`，执行 `node tests/e2e/run-p2.mjs`。它创建独立数据库 schema，启动真实 API、Worker、Vite 和本地模拟微信服务，使用 Playwright 验证登录、账号配置、封面上传、测试草稿，以及文章编辑、修订、预览、冲突、会话恢复、普通文章草稿投递和窄屏布局；结束后清理自有进程和测试数据。脚本名沿用 P2，实际运行 P2/P3/P4/P5 全部浏览器用例。

首次使用可运行 `npx playwright install chromium` 安装与当前锁文件匹配的浏览器；如使用已有浏览器，可通过 `TATTOO_E2E_BROWSER_EXECUTABLE` 指定可执行文件，不将本机路径写进仓库。在 Windows 上，应先停止本项目 API/Worker 子进程，再执行需要重新生成 Prisma Client 的构建，避免引擎 DLL 被占用。

本轮浏览器入口包含 P6 AI 配置、生成、改写和配图；模型与微信均由隔离的 HTTP 模拟服务提供，不使用真实密钥。完整执行 `node tests/e2e/run-p2.mjs`；定点联调可把 Playwright 文件过滤器传给该脚本，例如 `node tests/e2e/run-p2.mjs p2.spec.ts p6-ai.spec.ts`，同时保留基础草稿防重放与 AI 调用审计。模型接口及操作说明见 [模型配置与 AI 创作](MODELS.md)。

`tests/e2e/workspace-ui.spec.ts` 使用拦截 API 的离线 fixtures 检查三种外观、刷新记忆、系统变化、存储降级、编辑保护、快捷保存、弹窗键盘、会话恢复、独立微信预览和 390px 布局。它与 `article-digest.spec.ts` 一样需要 `TATTOO_E2E_TEST_MODE=1`；在独立前端服务器上运行时，另设置 `TATTOO_E2E_BASE_URL` 指向该服务。这些用例不调用真实模型、搜索或微信，不能替代真实 API/Worker 流程的回归或平台验收。

## 持久化与后续恢复

源码重建使用 `docker compose -f compose.yaml -f compose.build.yaml up -d --build --remove-orphans`，不要添加 `down -v`。备份应包含一致的 PostgreSQL 导出和素材卷，主密钥独立保存；已提供 `node scripts/backup.mjs` 与 `node scripts/restore.mjs`。源码部署的备份/恢复命令均添加 `--compose-file compose.yaml --compose-file compose.build.yaml`，按顺序使用同一组配置；管理电脑通过当前 Docker context 操作目标容器，数据库与素材采用同一次停机备份。具体参数、主密钥和匹配镜像保管、空实例恢复及旧任务核对见 [运维说明](OPERATIONS.md)。恢复实例先保持 `REMOTE_WRITES_ENABLED=false`，核对旧任务后再显式启用。此开关不代表微信账号已具备写权限。

恢复工具的独立容器验收入口为 `npm run verify:recovery`，需要已构建的应用镜像和可在管理电脑环回地址访问的 Docker 发布端口；沿用与构建及基础验收一致的 `TATTOO_IMAGE`。它使用临时配置，只创建随机隔离项目并在结束后删除自身容器、卷与临时目录，不读取仓库根 `.env` 或操作日常部署；历史四服务结果见 [P5 验证记录](P5-VERIFICATION.md)，本轮单镜像与 TOTP 恢复结果见 [P14 验证记录](P14-VERIFICATION.md)。
