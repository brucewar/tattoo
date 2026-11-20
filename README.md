# Tattoo

自托管的内容编辑与多平台投递工作台。第一阶段目标为微信公众号草稿箱，部署环境为群晖 Docker。

项目名称统一为 **Tattoo**，代码仓库：[brucewar/tattoo](https://github.com/brucewar/tattoo)。本地工程目录：`D:/github/tattoo`。

> 当前状态：**SPEC / PLAN 草案评审中**。仓库目前只有未验收的工程脚手架，尚不可作为完整应用部署，尚未通过真实微信公众号验收。

## 设计与实施

1. [需求规格与验收标准](docs/SPEC.md)
2. [技术设计](docs/ARCHITECTURE.md)
3. [实施计划与进度](docs/PLAN.md)

开发遵循 SPEC → PLAN → IMPLEMENT → VERIFY → RELEASE。需求和计划定稿后再继续业务实现；完成项必须有验证证据。

## 第一阶段范围

管理员登录、公众号配置与接口验证、文章和修订、图片上传、公众号排版预览、后台存草稿、投递记录、Docker Compose。后续预留知乎与小红书的独立内容适配和投递能力。

AI 写作、自动选题、周期生成、多平台真实发表不在本阶段范围。详情以 SPEC 为准。
