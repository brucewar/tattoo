# 运行维护

[文档首页](README.md) · [部署指南](DEPLOYMENT.md) · [开始使用](GETTING-STARTED.md) · [常见问题](FAQ.md)

日常启动、日志与升级在部署目录执行。备份和恢复使用匹配版本的管理工具，下面会分别标明命令执行位置。第一次安装请从[部署指南](DEPLOYMENT.md)开始。

下文下载与镜像保存示例针对 `0.1.0-rc.2`，发布状态与镜像 digest 见[版本说明](RELEASE-NOTES.md)中的标签流水线。已部署的旧版本继续保留匹配工具、原配置和主密钥；不要为升级重新生成配置。

## 查看状态与日志

在保存 `compose.yaml` 和 `.env` 的部署目录执行：

```bash
docker compose -p tattoo --env-file .env ps
docker compose -p tattoo --env-file .env logs --tail 100 api worker
docker compose -p tattoo --env-file .env images
```

正常部署包含 API、Worker 和 PostgreSQL 三个容器。API 先执行数据库迁移，健康后 Worker 才启动。启动失败时也可查看数据库日志：

```bash
docker compose -p tattoo --env-file .env logs --tail 100 postgres
```

关注健康状态、磁盘余量、备份成功记录和“结果待核对”任务。分享日志前移除凭证与个人内容，不公开完整 `compose config` 输出或 `.env`。远程草稿/素材和本地未引用文件目前不自动清理，按需人工管理。

以下默认项目名为 `tattoo`；使用其他项目名时，所有命令保持一致。`-p` 高于 Compose 的 `name:`，Shell 环境变量也可能覆盖 `.env`。普通重建保留命名卷，不需要删除数据库和素材。[Compose 参数](https://docs.docker.com/reference/cli/docker/compose/)

## 局域网与 HTTPS

在 `.env` 中设置浏览器实际使用的来源：

- 局域网：例如 `APP_ORIGIN=http://192.168.1.20:8080`，替换为实际主机地址与端口。
- 域名与 HTTPS：例如 `APP_ORIGIN=https://tattoo.example.com`，由已有反向代理终止 TLS 并代理到 Web 端口。

来源包含协议、主机和非默认端口，不包含路径。改动后在部署目录重新创建应用容器：

```bash
docker compose -p tattoo --env-file .env up -d --no-build --force-recreate --wait --wait-timeout 180 api worker
```

反向代理保留请求的 Host 和 Origin，允许上传 10 MiB 图片，并留出请求头与传输开销。生成任务异步执行，不要求代理等待整个模型调用。完成后按实际域名检查登录、刷新、保存和退出。

Docker 配置根据 `APP_ORIGIN` 决定会话 Cookie 的 Secure 属性，HTTPS 来源使用 Secure Cookie。当前 Compose 未传入单独的 `COOKIE_SECURE` 变量，以 `APP_ORIGIN` 为准。应用写请求校验来源，浏览器地址必须与配置一致。

## 微信接入与家宽出口

AppID、AppSecret 在自己的“公众号账号”页面输入，不放入命令或仓库。先执行只读验证，再明确决定是否创建草稿；token、草稿读取与新增草稿是不同权限，读取成功不能替代写入验证。

微信白名单填写请求微信 API 所用的实际出站公网 IP。NAS 内网 IP、浏览器公网 IP 或 DDNS 解析地址不能直接代替它。出现 `40164` 时按页面返回的出口 IP 排查；家宽出口变化后更新白名单，再执行只读验证。官方字段与权限依据见[微信核验记录](WECHAT-API.md)，实际验收见[真实微信验收](ACCEPTANCE.md#at-09-真实微信验收)。

### 启用微信草稿写入

准备明确创建远程草稿时，将部署 `.env` 中的 `REMOTE_WRITES_ENABLED` 改为 `true`，再在部署目录执行：

```bash
docker compose -p tattoo --env-file .env up -d --no-build --force-recreate --wait --wait-timeout 180 api worker
```

刷新页面后选择账号与已保存修订，按页面确认存入草稿。该开关只控制微信写入；关闭时，明确发起的模型验证、生成和 Tavily 搜索仍可能计费。当前只接入微信官方草稿接口，不直接发表或群发。

## 处理结果待核对的任务

连接中断或进程重启可能导致远端已经执行、Tattoo 却没有收到确定结果。先打开原任务获取结果，系统不会自动重放可能重复创建草稿或计费的请求。

微信投递显示“结果待核对”（`UNCERTAIN`）时：

1. 在部署目录执行 `docker compose -p tattoo --env-file .env stop worker`。
2. 到微信后台检查原账号及对应内容，回到投递记录填写“已创建”或“未创建”的人工结论。
3. 只有明确未创建时，才在原记录中显式重试。人工确认成功与接口已返回成功分别记录。
4. 核对后执行 `docker compose -p tattoo --env-file .env up -d --no-build --wait --wait-timeout 180 worker`。

同一实例或迁移前后不能同时运行多个 Worker。模型、主题创作及搜索任务先检查已有结果和服务商记录，再明确决定是否重新请求；主题封面失败可只补封面，最终保存中断可直接完成保存。

## 准备备份恢复管理工具

运行容器的 Docker 主机不需要 Node.js。现有备份和恢复工具需要在管理电脑准备：

- Node.js 22，至少 `22.15`。
- Docker CLI 与 Compose v2，可连接到要管理的 Docker 主机。
- 与备份对应应用版本匹配的源码工具。

管理电脑和 Docker 主机可以是同一台机器。这些脚本仅使用 Node 内置模块，无需执行 `npm ci` 或构建前端。

以当前候选版为例，在自己的工作目录取得固定版本源码：

```bash
git clone --branch v0.1.0-rc.2 --depth 1 https://github.com/brucewar/tattoo.git tattoo-tools
cd tattoo-tools
node --version
docker context show
docker compose version
docker info --format '{{.OSType}}/{{.Architecture}}'
```

不使用 Git 时，可以下载[该版本源码 ZIP](https://github.com/brucewar/tattoo/archive/refs/tags/v0.1.0-rc.2.zip)，解压后进入包含 `scripts` 的目录。后续升级要使用对应版本工具；旧备份使用备份时匹配的工具、Compose 和镜像，不用新工具假定兼容旧数据库。

Docker context 决定操作哪个主机，`DOCKER_CONTEXT`、`DOCKER_HOST` 也可能改变目标。备份归档保存到管理电脑，数据库与素材卷位于 Docker 主机；工具通过标准输入输出传送归档，不要求共享文件路径。远程 context 的连接与认证由管理者配置。[Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/)

下面的备份/恢复示例使用这个目录布局，可将路径替换为自己的实际位置：

```text
工作目录/
├── tattoo/             # 正在运行的部署：compose.yaml、.env
├── tattoo-tools/       # 固定版本源码：在此执行 node 管理命令
├── tattoo-backups/     # 在管理电脑创建的备份父目录
└── tattoo-restored/    # 恢复演练或迁移时使用的独立部署目录
```

管理工具必须指向实际部署文件。示例中的 `--compose-file ../tattoo/compose.yaml` 不可遗漏，否则工具会使用源码仓库自带的默认文件。多个 `--compose-file` 按顺序合并；一旦显式指定就不自动加入默认文件。源码构建实例使用原部署的 `compose.yaml` 与 `compose.build.yaml` 两个文件，后续手动 Compose 操作也保持同样的文件组合。

## 停机一致备份

先在其他浏览器窗口保存稿件并停止编辑，在管理电脑创建 `tattoo-backups` 父目录；不要预先创建本次输出目录 `before-upgrade`。确认当前 Docker context 指向源实例，然后在 **`tattoo-tools` 目录**执行：

```bash
node scripts/backup.mjs --output ../tattoo-backups/before-upgrade --project tattoo --env-file ../tattoo/.env --compose-file ../tattoo/compose.yaml
```

工具停止所选项目的 API 和 Worker，确认不再运行后，导出数据库与素材；PostgreSQL 保持运行。输出目录必须不存在，工具不覆盖旧备份。该方案要求没有其他程序绕过此 Compose 项目写入同一数据库或素材卷。

| 备份产物        | 内容                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `database.dump` | PostgreSQL 自定义格式归档，恢复使用 `pg_restore`，不是可交给 `psql` 的普通 SQL |
| `assets.tar`    | 本次备份的图片素材                                                             |
| `manifest.json` | 时间、大小、SHA-256、镜像及主密钥指纹等校验信息                                |

数据库和素材必须作为同一次备份共同保留。**另行保管原 `.env`、`APP_ENCRYPTION_KEY`、匹配的 Compose 文件和镜像**：工具不会把它们打进备份。丢失主密钥后不能解密已保存凭证，指纹不能替代密钥。归档包含文章、图片、凭证密文和密码哈希，按个人数据保管。[PostgreSQL 备份格式](https://www.postgresql.org/docs/16/app-pgdump.html)

备份成功或失败后，工具都不会自动重启应用。失败时保留错误信息，使用另一个新目录重做；只有完整成功的备份可用于恢复。确认待核对任务后，在原 **`tattoo` 部署目录**恢复服务：

```bash
docker compose -p tattoo --env-file .env up -d --no-build --wait --wait-timeout 180
```

普通重建和更新不使用 `down -v` 或全局卷清理，它们可能删除真实数据。[Docker volumes](https://docs.docker.com/engine/storage/volumes/)

## 保留匹配的镜像

当前恢复工具要求应用镜像 ID 与 manifest 一致，并使用 PostgreSQL 16；不提供忽略检查的强制恢复。相同源码重新构建不保证相同镜像 ID，备份也不包含镜像。因此升级、搬家前记录当前镜像 ID，并保留实际镜像。

在部署目录查看 `docker compose images`。若按本指南使用当前候选版，可把镜像另存到管理电脑：

```bash
docker image save --output ../tattoo-backups/tattoo-rc2-images.tar ghcr.io/brucewar/tattoo:0.1.0-rc.2 postgres:16-alpine
```

使用 `TATTOO_IMAGE` 或源码镜像时，替换为实际使用的镜像引用；不要把上面的候选版名称当作所有备份的固定值。在目标 Docker context 中加载：

```bash
docker image load --input ../tattoo-backups/tattoo-rc2-images.tar
```

`save/load` 不包含数据卷和 `.env`。使用命令的文件参数保存二进制归档，避免 Shell 文本重定向改动内容。[Docker image save](https://docs.docker.com/reference/cli/docker/image/save/)

## 升级与回滚

在原部署目录、同一项目名下升级：

1. 记录应用版本、镜像 ID、Docker 平台与配置，完成上面的停机一致备份，确认原主密钥和镜像副本可用。
2. 取得新版本对应的 Compose 与管理工具，检查版本变化，保留原主密钥、数据库密码和持久卷。
3. 修改 `TATTOO_VERSION`。若已设置优先级更高的 `TATTOO_IMAGE`，同步修改其完整引用或明确清除。
4. 拉取并启动，检查登录、文章、图片和任务记录。

```bash
docker compose -p tattoo --env-file .env pull
docker compose -p tattoo --env-file .env up -d --no-build --remove-orphans --wait --wait-timeout 180
docker compose -p tattoo --env-file .env ps
```

旧四服务部署升级时，`--remove-orphans` 移除同项目旧 Web 容器，让 API 接管原 Web 端口，不删除数据库和素材卷。迁移失败时查看错误，不绕过启动检查。

数据库已发生不兼容迁移时，不能只改回旧标签。按[恢复到空实例](#恢复到空实例)使用升级前备份、匹配镜像和原密钥恢复，再切换访问入口。应用升级不顺带升级 PostgreSQL 主版本；当前不承诺跨 CPU 架构恢复已验收。

## 恢复到空实例

恢复也可用于定期演练。准备可信且完整的备份、原主密钥、匹配工具与 Compose、精确镜像。使用独立项目名 `tattoo-restored` 和独立数据卷，不覆盖现有业务数据。

### 1. 准备恢复配置

在管理电脑创建 `tattoo-restored` 目录，放入备份版本对应的 `compose.yaml`。**不要先执行完整 `compose up`**，API 初始化迁移后就不再是空库。

在匹配版本的 **`tattoo-tools` 目录**生成独立配置：

```bash
node scripts/configure.mjs --output ../tattoo-restored/.env --origin http://localhost:18081
```

用编辑器调整新配置：

- `APP_ORIGIN` 与 `WEB_PORT` 使用新的实际访问地址；上例端口为 `18081`。
- `APP_ENCRYPTION_KEY` 替换为独立保存的原主密钥。
- `TATTOO_VERSION` 或优先级更高的 `TATTOO_IMAGE` 指向与备份一致的已保留镜像。
- `REMOTE_WRITES_ENABLED=false`，检查 Shell 环境未覆盖为其他值。
- 新数据库可使用新生成的数据库密码；恢复会带回原管理员，新初始化密码不会覆盖原密码。

### 2. 导入并检查

确认 Docker context 指向恢复目标，在 **`tattoo-tools` 目录**执行：

```bash
node scripts/restore.mjs --input ../tattoo-backups/before-upgrade --project tattoo-restored --env-file ../tattoo-restored/.env --compose-file ../tattoo-restored/compose.yaml
```

工具检查归档大小和哈希、主密钥指纹、应用镜像 ID、数据库版本、目标空库和空素材卷；要求目标应用已停止、远程写入关闭。只启动恢复所需 PostgreSQL，不自动启动 API 或 Worker，也不提供强制覆盖参数。只恢复自己可信保管的归档，哈希一致不能证明来源可信。[pg_restore 的信任边界](https://www.postgresql.org/docs/16/app-pgrestore.html)

恢复会撤销旧会话，冻结旧排队/执行中的投递、模型生成、资料及主题创作任务，避免自动重放草稿或收费请求；原成功、失败、待核对记录及已有候选、素材保留。原实例可能在备份后又创建过草稿，旧队列不能视为尚未执行。

在新 **`tattoo-restored` 部署目录**先只启动读取与核对所需服务：

```bash
docker compose -p tattoo-restored --env-file .env up -d --no-build --wait --wait-timeout 180 postgres api
docker compose -p tattoo-restored --env-file .env ps
```

重新登录，检查文章、修订、封面、正文图片和账号记录，按恢复演练检查凭证可解密。忘记原密码时使用[管理员密码恢复](#管理员密码恢复)，不重新初始化数据库。

已启用 TOTP 的实例恢复后仍需验证器。恢复会清除旧恢复码、登录挑战和待绑定设置，禁止重放当前或已使用时间步；先等动态码更新再登录，在“账户安全”重新生成并保存恢复码。详见[备份恢复后的登录](ACCOUNT-SECURITY.md#备份恢复后的登录)。

### 3. 核对旧任务并切换

先确认原实例 Worker 停止，再核对微信后台和恢复来的待核对任务，填写人工结论；模型及搜索任务也先检查已有结果，不自动重新请求。明确补封面时使用页面上的单独操作。

核对完成后，按实际需要启用微信远程写入，在恢复部署目录启动应用和 Worker：

```bash
docker compose -p tattoo-restored --env-file .env up -d --no-build --force-recreate --wait --wait-timeout 180 api worker
```

后续一直使用新项目名和配置。切换期间不同时启用原实例与恢复实例的 Worker。恢复失败或中断时保持 Worker 停止，检查保留错误；使用另一个真正空的项目重新恢复，不在部分导入的目标上反复强制操作。

## 迁移 Docker 主机

迁移采用同一套备份恢复流程：

1. 在源主机 context 完成停机一致备份，保存镜像、配置、匹配 Compose 和独立主密钥。
2. 将归档留在管理电脑或安全转移到新的管理电脑；切换到目标主机 context 并确认目标。
3. 加载原镜像，按[恢复到空实例](#恢复到空实例)导入并核对，调整实际访问地址及微信出口 IP 白名单。
4. 停止源 Worker 后切换访问入口，再明确启动目标 Worker。

不需要手工复制正在运行的数据库卷，也不同时运行两份业务 Worker。定期在独立空项目演练恢复，才能确认备份可用。

## 管理员密码恢复

登录状态下优先使用[账户安全](ACCOUNT-SECURITY.md#修改密码)修改密码。修改 `.env` 的 `ADMIN_PASSWORD` 不会重置已有管理员。应用镜像内提供部署侧重置工具，新密码要求 12 至 256 个字符；普通重置撤销全部旧会话与登录挑战，保留已启用 TOTP。

在对应部署目录执行，临时输入新密码，不把它写入命令参数或公开记录。

<details>
<summary>Linux / NAS（Bash）</summary>

```bash
read -r -s -p '新管理员密码: ' TATTOO_NEW_PASSWORD
export TATTOO_NEW_PASSWORD
docker compose -p tattoo --env-file .env exec -T -e TATTOO_NEW_PASSWORD api node scripts/reset-admin.mjs
unset TATTOO_NEW_PASSWORD
```

</details>

<details>
<summary>Windows（PowerShell）</summary>

```powershell
$tattooNewPassword = Read-Host '新管理员密码' -AsSecureString
$env:TATTOO_NEW_PASSWORD = [System.Net.NetworkCredential]::new('', $tattooNewPassword).Password
try {
  docker compose -p tattoo --env-file .env exec -T -e TATTOO_NEW_PASSWORD api node scripts/reset-admin.mjs
} finally {
  Remove-Item Env:TATTOO_NEW_PASSWORD
}
```

</details>

恢复实例使用它自己的项目名和环境文件。密码重置失败先检查 API、数据库和迁移状态，不删除数据卷。

验证器与恢复码同时丢失时，只有部署管理员明确使用 `TATTOO_RESET_2FA=true` 并提供新密码，才同时移除双重验证和全部恢复码。群晖 Container Manager 可通过 API 容器的 Bash 终端执行，无需 SSH；完整步骤见[丢失验证器和恢复码](ACCOUNT-SECURITY.md#丢失验证器和恢复码)。

## 维护记录

每次升级或恢复记录日期、应用版本、镜像 ID、实际平台和结果；备份后定期做空实例恢复演练。记录不包含密钥或个人内容。自动验证证据和真实服务验收的区别见[验收索引](ACCEPTANCE.md)。
