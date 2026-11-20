# P1 工程基础验证记录

日期：2026-11-20（Asia/Shanghai）。依据：SPEC v0.2、PLAN P1。

## 环境与结论

- 宿主：Windows，Node.js 22.15.0，npm 11.6.0。
- 容器：Docker Desktop Linux/amd64，Docker Engine 28.4.0，Compose 2.39.2，PostgreSQL 16.16。
- P1 工程基础通过；P2–P5 业务功能尚未验收。真实微信验收未执行。

## 已执行检查

| 命令或场景                           | 结果                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `npm ci --no-audit --no-fund`        | Windows 干净安装成功，528 个包；采用锁文件版本 3                                                   |
| `npm run typecheck`                  | contracts/server/web 严格 TypeScript 检查通过                                                      |
| `npm test`                           | 4 个测试文件、12 项测试通过：配置门槛、加密篡改、密码校验、脱敏、结构上限和配置防覆盖              |
| `npm run build`                      | Prisma Client、契约包、API/Worker 与 React/Vite 前端构建成功                                       |
| `npm run test:integration`           | 独立 PostgreSQL 中 4 项测试通过：投递唯一约束与认领竞争、历史素材保护、修订版本唯一、Worker 会话锁 |
| 初始迁移                             | `20261120000000_initial` 在空测试库成功应用；重复部署显示无待执行迁移                              |
| `docker compose config --quiet`      | 配置有效，仅 web 映射宿主端口                                                                      |
| `docker compose build`               | Linux/amd64 的 application、web 镜像构建成功；容器内 npm 10 干净安装成功                           |
| `node scripts/verify-foundation.mjs` | 独立 `tattoo-p1-smoke` 项目中的部署检查全部通过，结束后已停止测试容器                              |

部署脚本实际验证了四服务健康、API/Worker 共用镜像、页面和就绪接口返回成功、缺少主密钥拒绝启动、数据库迁移失败不启动 API、重复 Worker 无法取得执行权，以及重建所有容器后数据库记录与素材文件仍保留。验证用记录和文件已清除；测试容器已停止，隔离持久卷保留用于排查。

## 修复的构建问题

1. Vite 在测试工具与前端间出现两个版本，导致 React 插件类型冲突。统一为 6.4.6，并由锁文件约束。
2. 从已有 node_modules 更新锁文件遗漏 esbuild 平台包。使用只含依赖清单的干净目录重新生成，确认 Windows/Linux 等 26 个 0.28.2 平台包记录完整，并通过两个系统的安装与构建。
3. Windows 中 localhost 与只映射 IPv4 的数据库端口不一致。开发/测试数据库连接明确使用 `127.0.0.1`。

## 尚未通过的验收

- P1 不等于 AT-01 至 AT-09 全部完成；登录、账号验证、编辑器、真实投递、备份恢复仍需后续实施与验收。
- 未在目标群晖或 arm64 上运行，最低 NAS 硬件要求仍待实测。
- GitHub Actions 工作流已配置，远端执行结果以对应 Actions 运行记录为准，本记录不把本地通过写成远端 CI 已通过。
- Vite 提示主 JS 包约 501 kB，gzip 后约 162 kB。后续页面实际形成后按路由拆分，再评估完整应用体积。
