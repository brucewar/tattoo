# UI primitives

此目录的基础组件来自 [shadcn/ui 官方仓库](https://github.com/shadcn-ui/ui)，采用 `new-york-v4` registry 和 Radix primitives。`index.tsx` 是 Tattoo 的应用控件组合层。

2026-11-28 从官方 HTTPS raw 源下载了 Button、Input、Textarea、Dialog、Alert Dialog、Checkbox、Select、Tooltip、Dropdown Menu、Badge、Skeleton、Separator 和 Radio Group。源文件路径及下载原文的 SHA-256 记录在 [upstream.json](./upstream.json)。本次环境未能解析上游固定 commit，因此记录的是下载时的 `main` 和原文校验值；后续更新应重新核对来源和行为。

本地适配包括将 `cn` 指向项目的 `@/lib/utils`、将 registry 内部引用改为同目录引用、将关闭按钮文案改为中文，以及按项目格式化规则排版。业务状态、主题、表单标签和具体交互由应用组合层与页面负责。

上游采用 MIT License，完整版权与许可文本保留于 [LICENSE](./LICENSE)。这些组件不在运行时请求 registry；部署后的界面、图标和字体均从应用自身提供。
