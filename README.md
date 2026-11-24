# Tattoo

自托管的内容创作与多平台产出工作台，通过标准 Docker / Docker Compose 部署（包括支持 Docker 的 NAS）。完整目标涵盖 RSS/搜索/指定链接资料获取、AI 写作/改写/配图、微信公众号草稿，以及知乎与小红书内容导出和后续接入。

代码仓库：[brucewar/tattoo](https://github.com/brucewar/tattoo)。

> 当前状态：**已接入链接/RSS/搜索资料获取、模型配置、AI 写作/改写、封面与插图生成，当前为候选版本**。同时支持文章修订、微信草稿投递、Docker 部署与备份恢复。真实搜索、模型服务及微信公众号验收需在用户自己的环境完成。

## 设计与实施

1. [需求规格与验收标准](docs/SPEC.md)
2. [技术设计](docs/ARCHITECTURE.md)
3. [实施计划与进度](docs/PLAN.md)

开发遵循 SPEC → PLAN → IMPLEMENT → VERIFY → RELEASE。完成项必须有验证证据。

## 获取源码

```bash
git clone https://github.com/brucewar/tattoo.git
cd tattoo
```

将仓库克隆到自己选择的目录即可。

开发与 Docker 验证步骤见 [开发说明](docs/DEVELOPMENT.md)，实际结果见 [P1 验证记录](docs/P1-VERIFICATION.md)、[P2 验证记录](docs/P2-VERIFICATION.md)、[P3 验证记录](docs/P3-VERIFICATION.md) 和 [P4 验证记录](docs/P4-VERIFICATION.md)。

## 本地启动

Docker 主机需要运行 Linux 容器的 Docker Engine / Compose。以下配置命令在有 Node.js 22（至少 22.15）的管理电脑执行，Docker 主机不额外需要 Node.js。

```bash
node scripts/configure.mjs
docker compose up -d --build --wait
```

配置文件已存在时跳过配置生成，避免覆盖密钥。启动后访问 `http://localhost:8080`，使用本机 `.env` 的管理员配置登录。AppID/AppSecret 在账号设置页填写；创建测试草稿还需显式启用远程写入，步骤见开发说明。

登录后从左侧“模型配置”分别设置文本和图片模型的服务地址、模型名称及 API Key，执行各自的实际生成验证。文本协议支持 Chat Completions、Responses 和 Anthropic Messages；图片使用独立的 Images Generations 接口，两者可以使用不同服务。密钥仅在本机页面填写。编辑器中提供 AI 写作、改写、封面及插图生成，候选由用户明确采用，再保存为修订。配置与使用细节见 [模型配置与 AI 创作](docs/MODELS.md)。

运行维护、停机备份恢复和升级步骤见 [运维说明](docs/OPERATIONS.md)，自动验收与真实微信检查见 [验收索引](docs/ACCEPTANCE.md) 和 [P5 验证记录](docs/P5-VERIFICATION.md)。

“资料”页面支持公开链接正文提取、RSS/Atom 手动拉取和 Tavily 按需搜索。搜索结果明确采集后进入资料库，AI 写文章可选择已保存资料；密钥在自己的配置页面输入。操作和网络限制见 [资料获取](docs/SOURCES.md)。

## 已实现与后续范围

管理员登录、公众号配置与接口验证、文章和修订、图片上传、公众号排版预览、后台存草稿、投递记录、Docker Compose。普通文章到微信草稿的实现与本地模拟闭环已完成，Docker 部署与备份恢复已通过自动验收，真实微信公众号仍待用户环境验收。

本轮新增模型配置与后台生成任务，AI 产物进入现有编辑器、修订和素材流程；生成不会自动保存文章或投递微信。模型调用不受微信远程写入开关控制，用户明确发起的生成可能产生模型服务费用。

知乎内容导出、小红书文案和图片导出按 P10 继续实施，当前尚未实现。资料获取首批为手动操作；自动选题、周期生成、热点榜/日报和多平台真实发表仍需后续确认，不能把当前候选版本当作完整产品已完成。

当前采用 PostgreSQL 持久任务表和单 Worker；出现明确需求后再评估 Redis/BullMQ，详见 [架构决策](docs/adr/0001-postgresql-task-queue.md)。整体架构、阶段范围与验收分别以设计文档和验证记录为准。
