# 三种文本协议验证记录

日期：2026-11-24（Asia/Shanghai）。依据用户确认，文本模型支持 Chat Completions、Responses、Anthropic Messages；图片保持独立 Images Generations。本记录补充 [P6–P8 历史验证](P6-P8-VERIFICATION.md)，不改写此前测试结果。

## 实现范围

- 文本模型配置可选择协议，Anthropic 提供最大输出 token 上限；切换不覆盖地址、模型或密钥。
- 协议分别构造请求、鉴权和解析原始 HTTP 响应，共用内容校验、超时及错误处理；不自动切协议或重发收费请求。
- 旧文本配置和任务回填 Chat Completions，旧图片配置和任务回填 Images Generations；历史任务保留协议快照，修改协议或有效参数更新配置版本。
- Responses 的拒绝、未完成、工具输出，以及 Anthropic 的截断和非正常停止不生成可采用候选；推理/思考块不进入正文。
- Docker 升级、模型密钥加密与备份恢复保留协议及 Anthropic 参数。

## 验证入口

```bash
npm run build
npm test
npm run test:integration
node tests/e2e/run-p2.mjs
npm run format:check

docker compose build
node scripts/verify-foundation.mjs
npm run verify:recovery
```

集成和浏览器测试使用独立 PostgreSQL 测试库及本地 HTTP 模拟服务，不配置或调用真实付费模型。正式模型使用方法与协议依据见 [模型说明](MODELS.md)。

## 验证结果

| 检查                  | 结果                                                          |
| --------------------- | ------------------------------------------------------------- |
| 生产构建              | 通过，包含 Prisma、共享契约、Server 和 Web                    |
| 全部单元              | 205 / 205 通过，其中模型 Provider 91 项                       |
| PostgreSQL 集成       | 70 / 70 通过，其中 AI 27 项                                   |
| 格式及补丁检查        | Prettier、`git diff --check` 通过                             |
| Docker 四服务基础验收 | 健康检查、端口隔离、拒绝错误配置与重复 Worker、重建持久化通过 |
| Docker 正式镜像       | Linux/amd64 构建通过                                          |
| Docker 备份恢复       | 通过；保留协议、token 上限、密钥及历史结果，冻结旧任务        |

完整浏览器回归包含 20 项，使用真实 API、Worker 和 PostgreSQL，以及本地模型/微信 HTTP 模拟服务。新增流程分别验证 Responses、Anthropic 的协议选择、保存刷新、密钥留空保留、实际验证、文章候选采用及保存；已有 Chat 图文到微信草稿、失败处理、断线恢复、选区保护和窄屏流程继续覆盖。

本机 20 个用例均报告通过，但测试进程在浏览器退出阶段超过十分钟上限，该轮脚本未整体通过。完整回归由同一提交的 Linux CI 复核，运行链接随交付说明提供；不把本机用例完成等同于整个验证进程成功。

旧 schema 迁移测试实际应用旧版迁移并插入文本、图片模型及成功任务，再应用新迁移；验证协议回填，原密钥、配置版本和历史结果均保留。三协议的文章与改写通过真实 HTTP 模拟服务执行，覆盖鉴权、无密钥服务、有效参数、协议切换后的排队任务失效及历史快照。

恢复演练实际保存 Anthropic 配置与 8192 token 上限；停止源 Worker 后准备五种生成任务状态，再备份并恢复到空实例。恢复后配置与任务保留协议，模型密钥可解密，旧排队/运行任务变为待核对，已完成结果保持原样。未向真实模型发出请求，隔离容器与临时资源已清理。

Docker 环境：Engine 28.4.0、Compose 2.39.2-desktop.1，Linux/amd64；本次恢复验收使用镜像 `sha256:e529d92b87e5042e5281199f51df8d7c47e289f7574651dca23862f99b3c85a3`。正式镜像中的最终 Responses 错误标记与 Anthropic 版本头代码另行核对通过。

本地 Docker 预览已升级，真实浏览器检查三种协议可见、图片配置独立，升级前后的文章修订和模型元数据一致；密钥未重新输入或替换，也没有创建模型请求。截图仅保存于忽略的本地预览目录，不提交用户配置。

首轮完整浏览器运行在既有流程通过后，发现 Ant Design 只读 combobox 被选中文本覆盖，以及虚拟选项的隐藏辅助节点不能直接点击。终止该轮并清理隔离测试 schema，改用键盘打开和实际可见选项；未修改页面样式或放宽超时。

本轮未执行真实模型服务及微信公众号验收，仍需在用户环境分别完成。
