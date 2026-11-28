# 部署 Tattoo

[文档首页](README.md) · [开始使用](GETTING-STARTED.md) · [运行维护](OPERATIONS.md) · [常见问题](FAQ.md)

使用 Docker Compose 拉取镜像即可运行 Tattoo，宿主机不需要 Node.js、npm 或源码。以下步骤适用于支持 Linux 容器的 Docker 主机，包括 NAS；首次配置通过应用镜像生成。

本页适用于 `0.1.0-rc.2` 候选版本。发布状态、源码关联与准确镜像 digest 见[对应标签流水线](https://github.com/brucewar/tattoo/actions?query=branch%3Av0.1.0-rc.2)，版本差异见[版本说明](RELEASE-NOTES.md)。

## 部署前确认

| 项目           | 当前支持情况                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| 发布版本       | `0.1.0-rc.2`，候选版                                                                                                 |
| 应用镜像       | `ghcr.io/brucewar/tattoo:0.1.0-rc.2`                                                                                 |
| CPU / 容器平台 | 目标平台 `linux/amd64`（x86-64）；当前没有 ARM 镜像                                                                  |
| 容器环境       | Docker Engine 与 Docker Compose v2，需支持下文的 `--wait`、`--wait-timeout` 参数；Docker Desktop 使用 Linux 容器模式 |
| Web 端口       | 默认 `8080`，可修改                                                                                                  |
| 持久数据       | PostgreSQL 数据库和图片素材分别保存在 Docker 命名卷中                                                                |
| 运行服务       | `api`、`worker`、`postgres` 三个容器；API 与 Worker 共用一个 Tattoo 镜像                                             |

不限定 NAS 品牌或型号；请先确认 CPU 架构和容器环境。本候选版本的 Docker 与发布验证按[验收记录](P14-VERIFICATION.md)更新，真实模型、Tavily 和微信接口仍需使用自己的配置验证。

选择一个长期保留的部署目录，下面的 `compose.yaml` 和 `.env` 都保存在其中。部署时需能访问 GHCR、Docker Hub 和 GitHub 原始文件地址。

## 1. 下载 Compose 并生成配置

选择与你的终端对应的命令。两种方式都下载固定发布版本的文件，并生成随机数据库密码、管理员初始密码和加密主密钥。已有部署直接查看[升级与固定镜像](#升级与固定镜像)，无需重新生成配置。

<details open>
<summary><strong>Linux / NAS 终端</strong></summary>

在 Docker 主机上执行：

```bash
mkdir tattoo
cd tattoo
curl -fL https://raw.githubusercontent.com/brucewar/tattoo/v0.1.0-rc.2/compose.yaml -o compose.yaml
docker pull ghcr.io/brucewar/tattoo:0.1.0-rc.2
docker run --rm --user "$(id -u):$(id -g)" --mount "type=bind,source=$(pwd),target=/config" ghcr.io/brucewar/tattoo:0.1.0-rc.2 node scripts/configure.mjs --output /config/.env
```

配置以当前用户身份写入，避免生成只有其他用户可读的文件。若通过远程 Docker context 操作主机，绑定目录必须在 Docker 主机上可见；最直接的方式是在主机终端完成这一步。

</details>

<details>
<summary><strong>Windows / Docker Desktop（PowerShell）</strong></summary>

在 PowerShell 执行：

```powershell
New-Item -ItemType Directory -Path tattoo
Set-Location tattoo
docker pull ghcr.io/brucewar/tattoo:0.1.0-rc.2
docker run --rm --mount "type=bind,source=$((Get-Location).Path),target=/config" ghcr.io/brucewar/tattoo:0.1.0-rc.2 node --input-type=module -e "import { writeFile } from 'node:fs/promises'; const response = await fetch('https://raw.githubusercontent.com/brucewar/tattoo/v0.1.0-rc.2/compose.yaml'); if (!response.ok) throw new Error('Compose download failed: ' + response.status); await writeFile('/config/compose.yaml', await response.text(), { flag: 'wx' });"
docker run --rm --mount "type=bind,source=$((Get-Location).Path),target=/config" ghcr.io/brucewar/tattoo:0.1.0-rc.2 node scripts/configure.mjs --output /config/.env
```

该方式通过应用镜像内的 Node.js 下载 Compose，正常校验 HTTPS 证书，不依赖宿主 Node.js 或 PowerShell 的证书链环境。也可从[固定版本的 Compose](https://raw.githubusercontent.com/brucewar/tattoo/v0.1.0-rc.2/compose.yaml) 手动保存文件，再执行最后一条配置命令。

</details>

配置生成器拒绝覆盖已有 `.env`。请保管该文件，并为 `APP_ENCRYPTION_KEY` 留一份独立副本；它用于解密保存的公众号、模型及搜索凭证。

## 2. 设置浏览器访问地址

用本机编辑器打开 `.env`，优先核对 `APP_ORIGIN` 和 `WEB_PORT`：

- 只在 Docker 主机上访问：默认 `http://localhost:8080`。
- 从局域网电脑或手机访问：例如 `http://192.168.1.20:8080`，将示例 IP 换成 Docker 主机的实际地址。
- 使用域名与反向代理：例如 `https://tattoo.example.com`，配置见[局域网与 HTTPS](OPERATIONS.md#局域网与-https)。

`APP_ORIGIN` 必须与浏览器实际使用的协议、主机和端口一致，不含路径。改变 Web 端口时一并更新访问地址。

| 配置                             | 首次部署如何处理                             |
| -------------------------------- | -------------------------------------------- |
| `TATTOO_VERSION=0.1.0-rc.2`      | 保持固定候选版本                             |
| `APP_ORIGIN`                     | 改成上面确定的浏览器访问来源                 |
| `WEB_PORT=8080`                  | 未被占用时保留；占用时换一个端口             |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 用于首次登录；密码已随机生成，可在启动前修改 |
| `APP_ENCRYPTION_KEY`             | 保留生成值，独立备份；升级时不更换           |
| `POSTGRES_PASSWORD`              | 保留生成值；已有数据库不随意更换密码         |
| `REMOTE_WRITES_ENABLED=false`    | 暂时保持关闭；不影响手写或明确发起的 AI 创作 |

管理员只在空实例首次初始化。已有管理员不会被 `.env` 中的新密码覆盖，忘记密码见[管理员密码恢复](OPERATIONS.md#管理员密码恢复)。不要公开 `.env` 或把它提交到仓库。

## 3. 启动并登录

继续在部署目录执行：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d --no-build --remove-orphans --wait --wait-timeout 180
docker compose ps
```

打开配置的 `APP_ORIGIN`，使用 `.env` 中的管理员邮箱和密码登录。部署在 NAS 上时，浏览器应访问 NAS 的地址，而不是访问浏览器所在电脑的 `localhost`。

启动时会自动执行数据库迁移；迁移失败则 API 不启动，Worker 等 API 健康后再启动。只有 API 发布 Web 端口，Worker 和数据库不直接对外开放。遇到问题先查看[启动与登录排查](FAQ.md#页面打不开或登录失败怎么排查)。

登录后按照[开始使用](GETTING-STARTED.md)创建第一篇文章。模型 API Key、Tavily Key、微信 AppID/AppSecret 都在自己的页面配置，不填入部署命令。生成文章不会自动投递微信。

## 升级与固定镜像

升级前先完成[停机一致备份](OPERATIONS.md#停机一致备份)，保留原配置、主密钥、匹配的 Compose 文件和应用镜像。取得新版本对应的 Compose，保持原项目名和持久卷，再修改 `.env` 的 `TATTOO_VERSION`。

若设置了完整镜像引用 `TATTOO_IMAGE`，它的优先级高于 `TATTOO_VERSION`，应同步更新，或明确清除后使用版本标签。

```bash
docker compose pull
docker compose up -d --no-build --remove-orphans --wait --wait-timeout 180
docker compose ps
```

从旧四服务部署升级时，`--remove-orphans` 移除同项目旧 Web 容器，将原端口交给 API；数据库和素材卷保留。完整步骤及回滚见[升级与回滚](OPERATIONS.md#升级与回滚)。普通更新不执行 `down -v`。

若需按 digest 固定镜像，可把发布 workflow 摘要中的完整引用填入 `.env`：

```dotenv
TATTOO_IMAGE=ghcr.io/brucewar/tattoo@sha256:<发布摘要中的完整摘要值>
```

该配置同时用于 API 和 Worker。备份不包含镜像，恢复还需保留[匹配的镜像](OPERATIONS.md#保留匹配的镜像)；数据库已经迁移后，只改回旧标签不一定能回滚。

## 自动构建与版本

| 标签                    | 用途                                    |
| ----------------------- | --------------------------------------- |
| `0.1.0-rc.2` 等固定版本 | 个人部署优先使用，明确选择升级时机      |
| `sha-<40位提交哈希>`    | 定位通过 CI 的具体提交                  |
| `edge`                  | 主分支持续更新的开发版本                |
| `latest`                | 正式版本发布成功才更新；RC 不更新此标签 |

主分支通过 CI 后自动发布 `edge` 与提交标签。推送 `vX.Y.Z` 或预发布标签时，验证对应提交后发布去掉 `v` 的版本；已有版本/提交产物不会被其他提交覆盖，重试复用核对过的同一提交镜像。移动标签在镜像拉取及部署验收通过后更新。

## 备份恢复与源码构建

运行 Tattoo 的 Docker 主机无需 Node.js。现有备份、恢复工具需要在管理电脑上准备 Node.js 22 与匹配版本源码，通过 Docker CLI 操作实例；工具的获取方法和完整命令见[运行维护](OPERATIONS.md#准备备份恢复管理工具)。

默认 `compose.yaml` 只拉取镜像，不含 `build`。开发者从源码构建时使用 `compose.build.yaml` 覆盖文件，见[开发说明](DEVELOPMENT.md)。
