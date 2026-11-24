# P12 GHCR 发布与镜像部署验证记录

日期：2026-11-24（Asia/Shanghai）。用户已明确授权发布 GHCR 镜像、配置自动构建发布，以及提供直接拉取的 Compose 部署方式。规格见 [SPEC 第 13 节](SPEC.md#13-ghcr-发布与直接拉取部署2026-11-24已确认)。

## 实现与本地验证

- 默认 `compose.yaml` 为纯拉取，固定 `ghcr.io/brucewar/tattoo:0.1.0-rc.1`，API 与 Worker 共用引用；`TATTOO_IMAGE` 可以完整 digest 覆盖。
- `compose.build.yaml` 提供源码构建覆盖；默认拉取、源码镜像与 digest 覆盖均经 Compose 实际解析检查。
- 备份/恢复增加可重复 `--compose-file`，显式指定时按输入顺序使用，不隐式混入仓库默认配置。Foundation 与扩展恢复使用源码覆盖文件，通过三服务、端口迁移、拒启、执行互斥、持久化、密钥和旧活动任务冻结检查；隔离资源已清理。
- 完整单元测试 13 文件、262 / 262 通过，包含 12 项发布事件、SemVer、registry 认证与不可变标签门槛，以及 31 项备份/配置检查。
- 完整格式检查与 diff 检查通过，部署文档后续文字修订另做定点格式检查。源码应用镜像构建通过，包含配置生成器；正式发布仍由相同提交的 CI 再次构建与验收。

## 发布规则

CI 先验证准确提交，再运行仅对主分支和版本标签开放的发布 Job；PR 没有包写权限。仅用仓库 `GITHUB_TOKEN`，不新增 PAT。官方 Actions 固定提交 SHA，发布端固定 `linux/amd64`。

不可变标签通过 GHCR Registry HEAD 查验，只有 404 视为不存在；401/403 与服务端错误明确失败。已有标签须拉回核对源码 revision，不能覆盖另一提交。版本标签可复用同提交已有镜像；成功拉回准确 digest 并通过隔离 Compose 检查后，才更新 `edge` 或稳定版 `latest`。RC 不更新 `latest`。

发布后的验收入口为 `node scripts/verify-published.mjs --image ghcr.io/brucewar/tattoo@sha256:<digest>`：实际 pull，检查三服务、登录、静态页面与 API、图片、文章跨重建保留；同时验证镜像内随机配置、0600 权限及拒覆盖。过程不调用模型、Tavily 或微信。

## 首个远程发布

发布提交：`c098a2e67baff627598207b5dbc7b2ecf0265e62`。作者与提交者均为 `brucewar <brucewar@163.com>`。

- [主分支 CI 与发布](https://github.com/brucewar/tattoo/actions/runs/45346370836)：`completed / success`，包括完整验证、首次 GHCR scoped-token/权限检查、构建推送、按 digest 拉回部署及 `edge` 更新。
- [RC 标签 CI 与发布](https://github.com/brucewar/tattoo/actions/runs/45348301395)：`completed / success`。构建步骤明确跳过，复用已有 revision 成功，随后拉回相同 digest 再做三服务验收。
- 首次校验时 `0.1.0-rc.1`、`edge` 和 `sha-c098a2e67baff627598207b5dbc7b2ecf0265e62` 匿名 manifest HEAD 均为 200，引用同一产物：`ghcr.io/brucewar/tattoo@sha256:ee5f3b072c5db27cc71c322ff830a9d0d355f449b144a9ebc4956f260f0ec2bc`。
- RC 发布前后 `latest` 均为 404，未创建该标签。后续主分支发布可移动 `edge`，固定 RC 与 digest 不受影响。
- 可运行平台仅 `linux/amd64`；索引中的额外 `unknown/unknown` 为证明元数据，不代表额外运行架构。

官方文档提示首包需检查可见性；本次实际已可匿名读取，无需额外用户操作。匿名 token 请求不带账号凭据，随后 HEAD 和真实 Docker pull 均通过，不把登录后的 pull 或包页面 404 作为公开发布证据。

## 实际匿名部署与初始化

`node scripts/verify-published.mjs --anonymous --image ghcr.io/brucewar/tattoo@sha256:ee5f3b072c5db27cc71c322ff830a9d0d355f449b144a9ebc4956f260f0ec2bc` 在本机正常退出：

- 解析现有 Docker 引擎，隔离后比较 daemon ID，保证没有切换目标。
- 临时配置不复制用户凭据、凭据助手或凭据存储；使用空 GHCR 认证项抑制 Docker 自动发现系统凭据，仅保留可信 Compose 插件目录。
- 从 GHCR 重新拉取准确 digest，验证无本机构建的三个健康服务、登录、SPA/API 边界、图片上传、文章与素材跨容器重建保留，以及运行时配置生成的随机性/权限/拒覆盖。
- 隔离项目、数据库与素材卷及临时配置均清理成功，隔离验收未操作日常预览容器和数据。

Windows 免宿主 Node 初始化也已实际验证：用发布镜像内 Node 的标准 HTTPS fetch 下载 `v0.1.0-rc.1` Compose，绑定目录内生成随机 `.env`，Compose 配置解析通过。未关闭证书校验、未覆盖已有密钥、未执行模型/Tavily/微信调用。

本地首次默认 Docker pull 曾返回一次 `not found`，后续同一命令成功，未据此归因为凭据问题。首次匿名完整验收遇到 Docker Hub PostgreSQL token 网络 EOF；验证器随后在已有官方 PostgreSQL 标签时复用镜像缓存、每次仍创建全新数据库与素材卷，缓存不存在时照常 pull。Tattoo 镜像始终从 GHCR 强制拉回，重试由本次验证显式执行，没有加入自动重试掩盖失败。

主机 PowerShell 下载曾因本机 SSL 环境失败，因此 Windows 部署示例改用已验证的镜像内 HTTPS 下载方式。完整操作见 [部署说明](DEPLOYMENT.md)。
