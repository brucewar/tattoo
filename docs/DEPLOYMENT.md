# 从 GHCR 拉取镜像部署 Tattoo

首个候选版镜像为 `ghcr.io/brucewar/tattoo:0.1.0-rc.1`，平台为 `linux/amd64`。Docker 主机需要支持 Linux 容器的 Docker Engine 与 Docker Compose，不需要安装 Node.js、npm 或构建前端。当前真实模型和微信公众号验收仍需在自己的配置中完成。

## 首次部署

在自己选择的部署目录操作。部署使用一个应用镜像，API 和 Worker 分容器共用它；PostgreSQL 使用官方镜像，数据库与图片放在命名卷中。

### Linux / NAS

在 Docker 主机的终端执行：

```bash
mkdir tattoo
cd tattoo
curl -fL https://raw.githubusercontent.com/brucewar/tattoo/v0.1.0-rc.1/compose.yaml -o compose.yaml
docker pull ghcr.io/brucewar/tattoo:0.1.0-rc.1
docker run --rm --user "$(id -u):$(id -g)" --mount "type=bind,source=$(pwd),target=/config" ghcr.io/brucewar/tattoo:0.1.0-rc.1 node scripts/configure.mjs --output /config/.env
```

配置生成器用随机值创建数据库密码、管理员初始密码和加密主密钥，文件已存在时拒绝覆盖。通过当前用户身份写入部署目录，避免产生当前用户无法读取的配置文件。若通过远程 Docker context 操作其他主机，绑定目录需要在 Docker 主机上可见；也可先在管理电脑用仓库的 `node scripts/configure.mjs` 生成配置，再使用部署目录中的文件。

### Windows / Docker Desktop

在 PowerShell 执行：

```powershell
New-Item -ItemType Directory -Path tattoo
Set-Location tattoo
docker pull ghcr.io/brucewar/tattoo:0.1.0-rc.1
docker run --rm --mount "type=bind,source=$((Get-Location).Path),target=/config" ghcr.io/brucewar/tattoo:0.1.0-rc.1 node --input-type=module -e "import { writeFile } from 'node:fs/promises'; const response = await fetch('https://raw.githubusercontent.com/brucewar/tattoo/v0.1.0-rc.1/compose.yaml'); if (!response.ok) throw new Error('Compose download failed: ' + response.status); await writeFile('/config/compose.yaml', await response.text(), { flag: 'wx' });"
docker run --rm --mount "type=bind,source=$((Get-Location).Path),target=/config" ghcr.io/brucewar/tattoo:0.1.0-rc.1 node scripts/configure.mjs --output /config/.env
```

Docker Desktop 使用 Linux 容器模式。Windows 示例通过应用镜像下载 Compose，避免依赖主机 Node.js 或 PowerShell 的证书链环境，下载仍正常校验证书；文件已存在时拒绝覆盖。也可直接从[固定版本的 Compose](https://raw.githubusercontent.com/brucewar/tattoo/v0.1.0-rc.1/compose.yaml) 保存文件到部署目录。上述两种方式均不需要在宿主安装 Node.js。

### 修改配置并启动

用本机编辑器打开 `.env`，核对以下设置，不把配置文件内容发到聊天或公开日志：

| 设置                               | 用途                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `TATTOO_VERSION=0.1.0-rc.1`        | 固定使用该候选版本。                                                                         |
| `APP_ORIGIN=http://localhost:8080` | 必须改成浏览器实际访问的来源；局域网可用 `http://主机地址:8080`，域名访问填完整 HTTPS 来源。 |
| `WEB_PORT=8080`                    | 对外页面端口，与访问来源协调。                                                               |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD`   | 首次管理员；密码已随机生成，已有管理员不会被启动配置覆盖。                                   |
| `APP_ENCRYPTION_KEY`               | 主密钥；独立保管，升级时保持不变。                                                           |
| `POSTGRES_PASSWORD`                | 数据库密码；已有数据库继续使用原值。                                                         |
| `REMOTE_WRITES_ENABLED=false`      | 首次保持关闭，明确测试微信草稿前再开启。                                                     |

然后执行：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d --no-build --remove-orphans --wait --wait-timeout 180
docker compose ps
```

默认访问 `http://localhost:8080`，使用 `.env` 中的管理员配置登录。在“模型配置”分别保存文本和图片模型后，可在“内容 → 主题创作”输入主题生成图文；在“公众号账号”输入微信 AppID/AppSecret。生成内容不会自动投递微信。

只有 API 映射宿主 Web 端口，数据库和 Worker 不对外开放。首次启动自动执行版本化迁移；迁移失败不启动 API，Worker 等 API 健康后再启动。数据随命名卷保留，普通更新不要执行 `down -v`。

## 升级与固定镜像

先完成[停机一致备份](OPERATIONS.md#停机一致备份)，保留配置、主密钥和原镜像。取得新版本对应的 Compose 文件，保持原目录、项目名和数据卷，修改 `.env` 的 `TATTOO_VERSION` 后执行；如果设置了优先级更高的 `TATTOO_IMAGE`，同时更新其完整引用，或明确清除它后改用版本标签：

```bash
docker compose pull
docker compose up -d --no-build --remove-orphans --wait --wait-timeout 180
docker compose ps
```

从旧四服务部署升级时，`--remove-orphans` 移除同项目旧 Web 容器，将原端口交给 API，不删除数据库与素材卷。已有部署不要重新执行配置生成器。发布版只拉取镜像，不需要 `--build`。

需要精确固定发布产物时，取发布 workflow 摘要中的 digest，在 `.env` 设置完整引用：

```dotenv
TATTOO_IMAGE=ghcr.io/brucewar/tattoo@sha256:<发布摘要中的完整摘要值>
```

`TATTOO_IMAGE` 同时覆盖 API 与 Worker 的镜像，并优先于 `TATTOO_VERSION`。升级前记录实际应用镜像 ID；备份不包含镜像。回滚若涉及不兼容迁移，需要按匹配版本备份恢复，不能只改旧标签。

## 自动构建与版本

- 主分支通过 CI 后自动发布 `edge` 和完整提交哈希标签 `sha-<40位提交哈希>`。
- 推送 `vX.Y.Z` 或 `vX.Y.Z-预发布号` 标签时，验证对应提交后发布去掉 `v` 的镜像标签。
- `0.1.0-rc.1` 等预发布不会更新 `latest`；正式版本发布成功才更新 `latest`。
- 版本/提交标签已有产物时不覆盖其他提交；发布重试复用已核对的相同提交镜像。移动别名只在拉回镜像并完成部署验收后更新。

普通个人部署使用固定版本或 digest；`edge` 是持续更新的开发版本。本项目首版只发布已验证的 `linux/amd64`。

维护者首次发布后应在 GitHub 账号的 Packages 列表确认 Tattoo 镜像包为 Public，普通使用者才能匿名拉取。若包为 Private，入口为 Package settings → Danger Zone → Change visibility → Public，按页面输入包名确认，公开后不能改回私有。源码公开与包可见性分别设置，自动发布使用仓库令牌；公开镜像的使用者无需 Docker 登录。[GitHub 官方说明](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

## 备份恢复与开发

运行 Tattoo 不要求宿主 Node.js；现有备份恢复管理工具使用管理电脑上的 Node.js 22 和匹配版本源码，通过 Docker CLI 操作主机，见[运维说明](OPERATIONS.md)。独立下载 Compose 部署时，给管理工具指定该文件，例如：

```bash
node scripts/backup.mjs --output ./data/backups/before-upgrade --project tattoo --env-file /path/to/deployment/.env --compose-file /path/to/deployment/compose.yaml
```

路径为示例，请替换成自己的部署路径。多个 `--compose-file` 按输入顺序合并；一旦显式指定就不自动添加仓库默认文件。主密钥和匹配镜像仍需单独保管，恢复只接受真正空的目标。

源码构建使用仓库 `compose.build.yaml` 覆盖文件，见[开发说明](DEVELOPMENT.md)，与普通镜像部署分开。
