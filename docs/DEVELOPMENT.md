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

## 独立数据库集成测试

```bash
docker compose -f compose.test.yaml up -d --wait
```

将 `TEST_DATABASE_URL` 设置为 `postgresql://tattoo:tattoo_test@127.0.0.1:55432/tattoo_test`，然后运行 `npm run test:integration`。PowerShell 使用 `$env:TEST_DATABASE_URL = '...'`；bash 使用 `export TEST_DATABASE_URL='...'`。该入口先应用版本化迁移，再在真实 PostgreSQL 中验证约束。测试只允许名称包含 `test` 的独立数据库，不连接生产库。测试配置使用明确的环回地址，避免 Windows 下 localhost 优先解析到 IPv6 而容器只映射 IPv4。

测试完成后运行 `docker compose -f compose.test.yaml down`。测试库使用 tmpfs，容器删除即丢弃测试数据；主应用的持久卷不会受影响。

## Docker 部署骨架

```bash
npm run setup
docker compose config --quiet
docker compose build
docker compose up -d --wait
```

配置文件已存在时跳过 `setup`。默认访问 `http://localhost:8080`；局域网访问需将 `.env` 的 `APP_ORIGIN` 改为实际访问来源，包括端口。API 与 Worker 共享应用镜像，只有 web 对宿主开放端口。API 在启动前执行 `prisma migrate deploy`，失败则不启动 HTTP 服务；Worker 等待 API 就绪后启动。数据库与图片使用命名卷。

当前 P1 只验证工程入口、健康检查和单 Worker 执行权，不表示登录、编辑或微信投递已完成。初始密码会在 P2 管理员初始化功能中使用，不能把启动页视为业务验收。

镜像构建完成后，可运行 `node scripts/verify-foundation.mjs` 执行隔离部署验证。它使用固定的 `tattoo-p1-smoke` Compose 项目和 18080 端口，验证健康检查、启动失败门槛、Worker 互斥和容器重建持久化；结束后停止测试容器，保留隔离测试卷用于排查。不要将该项目名用于真实部署。

## 持久化与后续恢复

普通重建使用 `docker compose up -d --build`，不要添加 `down -v`。备份应包含一致的 PostgreSQL 导出和素材卷，主密钥独立保存；完整备份恢复脚本与实测在 P5 交付。恢复实例先保持 `REMOTE_WRITES_ENABLED=false`，核对旧任务后再显式启用。此开关不代表微信账号已具备写权限。
