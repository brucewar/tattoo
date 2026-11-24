# 安全说明

Tattoo 当前发布 `0.1.0-rc.1` 候选版，建议先在可信局域网使用。需要从外部访问时，为实例配置 HTTPS，并限制访问范围；部署细节见[局域网与 HTTPS](docs/OPERATIONS.md#局域网与-https)。

## 报告漏洞

发现身份认证、凭证泄露、越权访问或其他安全问题，请发邮件至 **[brucewar@163.com](mailto:brucewar@163.com)**，暂不要在公开 Issue 中附上利用细节。

请提供使用版本、影响范围和最小复现步骤。示例使用虚构数据；不发送真实 API Key、公众号 AppSecret、`.env`、数据库备份、会话 Cookie 或私人文章。可以先说明你有哪些日志，按需要再提供脱敏片段。

普通安装或使用问题请通过 [Issue](https://github.com/brucewar/tattoo/issues/new/choose)反馈。

## 保护自己的实例

- 保存好 `.env`，为 `APP_ENCRYPTION_KEY` 留独立副本。数据库和图片备份不包含恢复凭证所需的原主密钥。
- 远程写入默认关闭，首次微信测试由自己确认后开启。恢复实例后先核对旧任务和远程草稿，再决定启用写入。
- 更新前备份，保留匹配的应用镜像与 Compose 配置。恢复和迁移按[运行维护](docs/OPERATIONS.md)执行。

安全修正和使用限制会记录在[版本说明](docs/RELEASE-NOTES.md)中。部署固定版本时，请关注后续更新并自行安排升级。
