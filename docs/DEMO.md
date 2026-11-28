# GitHub Pages 在线演示

演示地址：<https://brucewar.github.io/tattoo/>。首次启用并成功运行 Pages 工作流后可访问。

演示复用正式版工作台，在构建时选择 `demo` 模式。无需 API、数据库、登录或任何服务凭证。

## 可以体验什么

- 预置文章的富文本编辑、新建文章、保存独立修订、查看历史与微信预览。
- 本地图片与封面，演示单张上限为 2 MiB，受浏览器存储容量限制。
- 主题创作、文章生成、改写和图片候选的采用流程。所有 AI 结果均为固定本地示例，不代表真实模型能力。
- 资料、投递记录、公众号、模型与账户安全的界面。联网采集、微信投递、凭证保存及安全设置修改不可用；不要输入真实密钥或密码。

演示文章、修订、任务和图片仅保存在当前浏览器的 `localStorage` 中，刷新后保留，不会上传或跨设备同步。清理浏览器站点数据或使用“重置演示”可恢复预置数据。存储被禁用或写满时会提示保存失败；未明确保存的编辑不会保留。预览中的正文图片显示占位说明，编辑器内可查看实际图片。

## 启用 GitHub Pages

1. 将本次变更提交并推送到 GitHub 的 `main` 分支。
2. 打开仓库 **Settings → Pages → Build and deployment**，将 **Source** 选择为 **GitHub Actions**。
3. 在 **Actions → GitHub Pages demo** 中选择 **Run workflow**，或再向 `main` 推送前端相关修改。
4. 等待 `build` 与 `deploy` 成功；部署任务会显示最终 URL。

工作流只用 `GITHUB_TOKEN`，无需设置 Secret；不安装数据库、不生成 Prisma 客户端，也不构建后端。PR 只构建并运行演示检查，不发布。部署仅允许 `main`，首次部署如果受环境保护规则限制，需按仓库现有规则处理。

默认地址为 `https://<owner>.github.io/<repository>/`，构建时由 `TATTOO_PAGES_BASE` 指定仓库子路径。若使用 `<owner>.github.io` 仓库或自定义域名根路径，请将工作流中的该值改为 `/`。代码部署沿用 GitHub 官方 [Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)和 [Vite 静态部署](https://vite.dev/guide/static-deploy#github-pages)约定。

## 本地开发与预览

需要 Node.js 22.15+（22.x）和 npm 10/11：

```bash
npm ci
npm run dev:demo
```

打开终端中的地址即可，不必启动后端。检查静态产物：

```bash
npm run build:demo
npm run preview:demo
```

默认使用相对资源路径，产物位于 `apps/web/dist-demo`。正常的 `npm run build` 仍生成正式版 `apps/web/dist`，使用真实同源 API，不注入示例数据。

模拟 `/tattoo/` 子路径的构建与浏览器检查（PowerShell）：

```powershell
$env:TATTOO_PAGES_BASE = '/tattoo/'
npm run build:demo
npx playwright install chromium
npx playwright test --config playwright.demo.config.ts
```

单元检查：`npx vitest run tests/unit/demo.test.ts`。浏览器检查包括子路径访问、保存刷新、修订历史、微信预览、各页面导航、手机导航入口，以及演示不请求 `/api/`。

2026-11-28 本地验证：全部 294 项单元测试、2 项演示浏览器检查、正式与演示前端构建通过；已检查桌面与手机截图，确认子路径的主题脚本和资源无 404，正式构建不含演示数据适配器。尚未执行 GitHub 远程部署。
