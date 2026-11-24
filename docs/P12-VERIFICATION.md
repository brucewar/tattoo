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

## 远程验收状态

本地构建和模拟门槛不代替 GHCR 的实际发布。首个版本、实际 digest、对应 CI 和匿名拉取结果在远程流程完成后记录。

GHCR 首个包默认 private，公开源码仓库不自动改变包可见性。首次发布后需在包设置中完成一次 Public 设置，再执行匿名拉取检查。登录后的 pull 或包页面 404 不作为匿名发布成功的证据。
