# Docker 部署、备份恢复与升级

本文面向标准 Docker / Compose 环境，运行 Linux 容器；已验证的平台和结果以 [验收索引](ACCEPTANCE.md) 及各阶段验证记录为准。其他 CPU 架构未实测时如实记录，不将 Docker 支持等同于所有架构已经通过。

## 管理端与 Docker 主机

运行配置、备份和恢复命令的管理电脑需要 Node.js 22（至少 22.15）和 Docker CLI / Compose 插件。这些脚本只使用 Node 内置模块；Docker 主机只负责运行容器，不额外要求安装 Node.js，两者可以是同一台电脑。源码开发与测试的依赖安装见 [开发说明](DEVELOPMENT.md)。

以下命令在检出的仓库根目录执行。先确认 Docker CLI 当前连接的是预期主机：

```bash
docker context show
docker compose version
docker info --format '{{.OSType}}/{{.Architecture}}'
```

Docker context 决定 CLI 操作哪个 Docker daemon，`DOCKER_CONTEXT`、`DOCKER_HOST` 等设置可能改变目标。每一步都要先确认预期 context；搬迁主机时，在源 context 备份，在目标 context 恢复并继续管理目标实例。远程 context 的连接与认证由管理者预先配置。备份目录和镜像归档保存在运行命令的管理电脑，数据库与素材卷位于 Docker 主机，工具通过标准输入输出传送归档，不要求两台电脑共享路径。[Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/)

## 首次部署

```bash
node scripts/configure.mjs
```

配置生成器只创建不存在的 `.env`，与 `npm run setup` 相同。已有部署不要再次生成主密钥。通过本机编辑器修改配置，不把文件内容贴到聊天、Issue 或公开日志。

| 配置                             | 用途                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                     | 浏览器实际访问来源，含协议与非默认端口，不含路径。例如 `http://192.168.1.20:8080`；请替换为实际地址。 |
| `WEB_PORT`                       | Docker 主机上的 Web 端口，默认 `8080`；与访问来源及反向代理配置协调。                                 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首次初始化管理员；已有管理员不会被启动配置覆盖。初始化后可移除初始密码。                              |
| `APP_ENCRYPTION_KEY`             | 生成的 32 字节主密钥，供已保存账号解密；独立备份，升级时保持不变。                                    |
| `POSTGRES_PASSWORD`              | 生成的数据库密码。保留部署配置，不随意修改已有数据库的连接密码。                                      |
| `REMOTE_WRITES_ENABLED`          | 首次保持 `false`，真实测试草稿前再显式开启。                                                          |
| `TATTOO_VERSION`                 | 单一应用镜像的标签，API 与 Worker 共用。建议填写已检出的提交短哈希，避免反复覆盖 `local` 标签。       |

```bash
docker compose -p tattoo --env-file .env config --quiet
docker compose -p tattoo --env-file .env build
docker compose -p tattoo --env-file .env up -d --wait --wait-timeout 180
docker compose -p tattoo --env-file .env ps
docker compose -p tattoo --env-file .env images
```

`up --wait` 等待服务运行或健康。API 启动前应用版本化迁移，迁移失败不启动 HTTP；Worker 等 API 健康后启动。前端页面包含在应用镜像内，由 API 同源提供；API 和 Worker 共用镜像，固定一个 Worker。Compose 共三个容器，只有 API 发布宿主 Web 端口；数据库与素材分别放在命名卷中。[Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)

记录源码提交、应用镜像 ID、Docker / Compose 版本和实际平台。镜像应匹配 Docker 主机的平台；多平台构建能力不等于本项目已经发布或实测所有平台的镜像。[Docker 多平台镜像](https://docs.docker.com/build/building/multi-platform/)

默认项目名是 `tattoo`。使用其他项目名时，后续备份、日志、停机和恢复命令也要显式使用该名称。`-p` 优先于配置文件中的 `name:`；环境文件可用 `--env-file` 指定，Shell 环境变量可能覆盖文件内的值。[Compose 项目与参数](https://docs.docker.com/reference/cli/docker/compose/)、[环境变量优先级](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

## 局域网与 HTTPS

局域网访问时，将 `APP_ORIGIN` 设置为实际访问的 `http://主机:端口`，并只向所需网络开放 Web 端口。改动后重新创建应用容器：

```bash
docker compose -p tattoo --env-file .env up -d --force-recreate --wait api worker
```

使用域名和 HTTPS 时，由已有反向代理终止 TLS，代理到 Tattoo 的 Web 端口；将 `APP_ORIGIN` 改为完整 HTTPS 来源，例如 `https://tattoo.example.com`。代理保留请求的 Host 和 Origin，允许上传 10 MiB 图片并留出请求头和传输开销；生成任务异步执行，不要求代理等待整个模型调用。通过 HTTPS 访问后检查登录、刷新和退出。

Docker 配置根据 `APP_ORIGIN` 自动决定会话 Cookie 的 Secure 属性，HTTPS 来源使用 Secure Cookie。源码运行时可通过 `COOKIE_SECURE` 明确配置，HTTPS 不允许关闭 Secure。当前 Compose 未单独传入该变量，因此修改 Docker 配置时以 `APP_ORIGIN` 为准。应用写请求按来源校验，不能用另一个协议、主机名或端口悄悄替代已配置的来源。

## 微信接入与家宽出口

AppID、AppSecret 只在本机页面的公众号账号设置中输入，不写入仓库或命令行示例。先运行只读验证，再决定是否显式创建测试草稿；获取 token、读取草稿和新增草稿是不同的权限证据。

微信白名单填写请求微信 API 时实际使用的出站公网 IP。Docker 主机内网地址、浏览器公网 IP、域名的 DDNS 解析地址都不能直接替代它。出现 `40164` 时按页面返回的出口 IP 排查；家宽出口变化后更新白名单，再执行只读验证。平台规则与来源见 [微信核验记录](WECHAT-API.md)，真实操作及记录要求见 [AT-09](ACCEPTANCE.md#at-09-真实微信验收)。

## 停机一致备份

先通知自己其他浏览器窗口保存稿件并停止编辑。备份工具停止所选项目的 API 和 Worker，确认应用容器不再运行后导出 PostgreSQL 与素材；PostgreSQL 保持运行以便执行逻辑导出。先在管理电脑创建 `data/backups` 父目录，不要创建下面的 `before-upgrade` 输出目录。

```bash
node scripts/backup.mjs --output ./data/backups/before-upgrade --project tattoo --env-file .env
```

输出目录必须是一个尚不存在的新目录。备份包含 `database.dump`、`assets.tar` 及记录大小、SHA-256、时间、镜像和主密钥指纹的 `manifest.json`；不包含主密钥、完整部署配置或镜像文件。数据库使用 PostgreSQL 自定义归档格式，由 `pg_restore` 恢复；不能把该文件当作普通 SQL 交给 `psql`。[PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)

数据库与素材必须作为同一次备份共同保留。另行保管原 `APP_ENCRYPTION_KEY` 和受保护的部署配置；只有数据归档而丢失主密钥，不能恢复已加密的账号。主密钥指纹用于发现配错密钥，不代替密钥。备份内仍有文章、图片、账号密文和密码哈希，按个人数据保管。

工具不自动重启原应用或 Worker。备份失败时也保持应用停机；检查错误并使用另一个新输出目录重做。只有完整成功的备份才能用于恢复。确认是否存在待核对投递后，由管理者显式恢复原实例：

```bash
docker compose -p tattoo --env-file .env up -d --wait --wait-timeout 180
```

该方案要求没有绕过此 Compose 项目的其他程序向同一数据库或素材卷写入。Docker 命名卷独立于容器保留，普通重建不需要删除卷。不要对真实部署执行 `down -v` 或全局卷清理；`-v` 会删除 Compose 声明的命名卷。[Docker volumes](https://docs.docker.com/engine/storage/volumes/)、[Compose down](https://docs.docker.com/reference/cli/docker/compose/down/)

## 保留匹配的镜像

首版恢复要求目标应用镜像 ID 与 manifest 一致，并使用 PostgreSQL 16；不提供忽略版本检查的强制恢复。相同标签可以指向不同镜像，在新电脑重新构建相同源码也不能保证得到相同 ID。备份不包含镜像，因此升级前保留原镜像；需要搬迁 Docker 主机时，另外保存它们。

下例 `release-a` 是示例，请替换为备份时 `TATTOO_VERSION` 实际使用的标签：

```bash
docker image save --output ./data/tattoo-images.tar tattoo-app:release-a postgres:16-alpine
```

在目标 Docker context 中加载：

```bash
docker image load --input ./data/tattoo-images.tar
```

`save` 导出镜像，`load` 恢复镜像及标签；它们不包含运行容器的数据库卷、素材卷或本地 `.env`。用命令的文件参数保存二进制归档，避免 Shell 文本重定向改变内容。[Docker image save](https://docs.docker.com/reference/cli/docker/image/save/)、[image load](https://docs.docker.com/reference/cli/docker/image/load/)

## 恢复到空实例

选择新项目名，例如 `tattoo-restored`，并创建独立配置。先不要为它执行完整的 `compose up`，API 初始化迁移后就不再是空库。

```bash
node scripts/configure.mjs --output .env.restore --origin http://localhost:18081
```

在本机编辑 `.env.restore`：设置实际访问的 `APP_ORIGIN` 与匹配的 `WEB_PORT`（上例端口为 `18081`）；将主密钥替换为独立保存的原 `APP_ENCRYPTION_KEY`；`TATTOO_VERSION` 指向已加载、与备份一致的应用版本；保持 `REMOTE_WRITES_ENABLED=false`。新数据库可使用新生成的数据库密码。已有管理员会随数据恢复，新配置的初始管理员密码不会覆盖其旧密码。

确认当前 Shell 没有用环境变量将远程写入开关或配置覆盖为其他值。使用备份对应源码的恢复工具、Compose 文件和镜像：

```bash
node scripts/restore.mjs --input ./data/backups/before-upgrade --project tattoo-restored --env-file .env.restore
```

恢复前校验归档大小与哈希、主密钥指纹、应用镜像 ID、数据库版本、目标空库与空素材卷，并要求远程写入关闭。目标应用必须已停止，不覆盖已有业务数据，也不通过 `--force` 绕过检查。哈希只能发现归档与 manifest 不一致，不能证明来源可信；只恢复自己可信保存的备份。PostgreSQL 的恢复会执行归档中的数据库定义。[pg_restore 的归档与信任边界](https://www.postgresql.org/docs/16/app-pgrestore.html)

工具只启动恢复所需 PostgreSQL，不自动启动 API 或 Worker。恢复后撤销原会话，旧 `QUEUED` / `RUNNING` 投递进入 `UNCERTAIN` 并保留核对事件；已有成功、失败和待核对记录保留。原实例可能在备份之后已经创建远程草稿，因此不能把旧队列当作尚未投递直接重放。

P6–P8 的模型密钥同样随数据库备份并检查解密，旧排队/运行的生成任务也会冻结，不自动重新请求模型。恢复后先检查最近生成任务和已保存素材；微信写入开关只控制微信，用户明确发起的模型生成仍可能计费。配置和使用见 [模型说明](MODELS.md)。

主题创作任务和已生成的文章候选、封面、最终文章关联同样保留。恢复冻结旧排队/执行中的主题任务，不能自动发起下一阶段的模型调用；需要明确补封面时，在页面单独重试。

先仅启动读取与核对所需的服务：

```bash
docker compose -p tattoo-restored --env-file .env.restore up -d --wait --wait-timeout 180 postgres api
docker compose -p tattoo-restored --env-file .env.restore ps
```

重新登录，确认文章、修订历史、封面与正文图片可读取，账号记录仍在；按本次恢复演练记录检查账号密文可用。忘记原管理员密码时使用 [部署侧密码重置](DEVELOPMENT.md#管理员密码恢复)，不要重新初始化数据库。

在投递记录中逐条核对恢复来的待核对任务。先确认原实例 Worker 已停止，再到微信后台检查，填写“已创建”或“未创建”的人工结论；只有明确未创建的任务才另行显式重试。人工确认成功不会冒充接口返回成功。切换完成前不得同时启用原实例与恢复实例的 Worker。

核对完成后，才在 `.env.restore` 显式启用远程写入，并重新创建应用与 Worker：

```bash
docker compose -p tattoo-restored --env-file .env.restore up -d --force-recreate --wait api worker
```

后续维护持续使用恢复实例的项目名和环境文件。恢复中断或失败时，不启动 Worker，也不对已经部分导入的目标反复强制导入；检查保留的错误和数据，使用另一个真正空的项目重新恢复。

## 升级与回滚

1. 记录当前提交、镜像 ID 和配置，保存当前镜像，完成停机一致备份，并确认独立密钥副本可用。
2. 检出经过验证的新提交，将 `TATTOO_VERSION` 改为新标签；保留原主密钥、数据库密码和持久卷。
3. 重新构建并启动，等待健康检查，检查登录、文章、图片与任务记录。由旧版四服务升级时，使用下方 `--remove-orphans` 移除同项目的旧 Web 容器，将原 Web 端口交给 API；数据库与素材卷保持。迁移失败时排查原因，不绕过启动门槛。

```bash
docker compose -p tattoo --env-file .env build
docker compose -p tattoo --env-file .env up -d --remove-orphans --wait --wait-timeout 180
docker compose -p tattoo --env-file .env ps
```

发生不兼容迁移时，按上节将升级前的数据备份恢复到空实例，使用备份匹配的镜像和密钥，再切换访问入口。仅改回旧镜像标签不能撤销数据库迁移。本阶段不在升级应用时顺便升级 PostgreSQL 主版本，也不承诺跨 CPU 架构恢复已经验收。

## 日常检查与执行记录

```bash
docker compose -p tattoo --env-file .env ps
docker compose -p tattoo --env-file .env logs --tail 100 api worker
```

关注健康状态、磁盘余量、备份成功记录和“结果待核对”任务。对外分享日志前移除凭证及个人内容；不要发布完整 `compose config` 输出或环境文件。远程素材、草稿及本地未引用文件目前不自动清理，按需人工管理。

每次部署或恢复记录日期、源码版本、镜像 ID、实际 Docker 平台、执行步骤及返回结果；备份成功后定期在独立空项目完成恢复演练。执行记录可以引用被忽略的本地证据目录，但不能把密钥或个人内容提交到仓库。

本文官方 CLI 语义于 2026-11-20 核验。工具实际行为以仓库实现和对应验证记录为准；支持标准 Docker 不表示指定远程连接、所有架构或真实微信公众号权限已通过验收。
