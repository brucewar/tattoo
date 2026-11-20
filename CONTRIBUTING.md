# 参与 Tattoo 开发

先阅读 [SPEC](docs/SPEC.md)、[技术设计](docs/ARCHITECTURE.md) 和 [PLAN](docs/PLAN.md)。需求变更先更新规格及验收项，避免提前引入多平台、并发和插件系统。

使用 Node.js 22（至少 22.15）与 npm 10/11，执行 `npm ci`。提交前运行 `npm run format:check`、`npm run typecheck`、`npm test`、`npm run build`；修改数据库模型时提交版本化迁移并执行集成测试。生产只使用 `prisma migrate deploy`。

PR 说明实际行为、验证命令和未执行项。不要提交 `.env`、平台凭证、数据库备份、上传图片或开发机绝对路径。真实微信操作只能在账号持有者明确发起后执行；模拟测试不能冒充真实权限验收。
