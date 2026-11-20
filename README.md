# Tattoo

自托管的内容编辑与多平台投递工作台。第一阶段目标为微信公众号草稿箱，部署环境为群晖 Docker。

代码仓库：[brucewar/tattoo](https://github.com/brucewar/tattoo)。

> 当前状态：**P3 内容编辑与本地验收已完成**。支持文章编辑、图片、不可变修订、冲突处理及公众号预览，保留 P2 的账号验证和固定测试草稿入口；普通文章投递在 P4，真实微信公众号验收未执行。

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

开发与 Docker 验证步骤见 [开发说明](docs/DEVELOPMENT.md)，实际结果见 [P1 验证记录](docs/P1-VERIFICATION.md)、[P2 验证记录](docs/P2-VERIFICATION.md) 和 [P3 验证记录](docs/P3-VERIFICATION.md)。

## 本地启动

需要 Node.js 22（至少 22.15）和 Docker Compose。

```bash
npm ci
npm run setup
docker compose up -d --build --wait
```

配置文件已存在时跳过 `setup`，避免覆盖密钥。启动后访问 `http://localhost:8080`，使用本机 `.env` 的管理员配置登录。AppID/AppSecret 在账号设置页填写；创建测试草稿还需显式启用远程写入，步骤见开发说明。

## 第一阶段范围

管理员登录、公众号配置与接口验证、文章和修订、图片上传、公众号排版预览、后台存草稿、投递记录、Docker Compose。后续预留知乎与小红书的独立内容适配和投递能力。

AI 写作、自动选题、周期生成、多平台真实发表不在本阶段范围。详情以 SPEC 为准。
