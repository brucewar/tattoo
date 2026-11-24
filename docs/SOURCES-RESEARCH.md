# P9 资料获取：接口与解析方案核验

核验日期：2026-11-24（Asia/Shanghai）。本记录只含公开文档、源码和 npm 元数据调研；未调用真实 Tavily、未安装依赖，也不代表功能已实现或验收通过。依赖安装、类型检查和运行烟测由实施阶段单独记录。

## Tavily Search：已确认

官方接口为 `POST https://api.tavily.com/search`，JSON 请求，密钥使用 `Authorization: Bearer <key>`。返回的 `results` 包含标题、URL、内容片段和相关度；`content` 是检索片段，不能直接标为原文全文。依据：[Search API 与 OpenAPI](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Markdown 规范](https://docs.tavily.com/documentation/api-reference/endpoint/search.md)。

首批建议显式发送以下参数，其余保持服务默认值：

```json
{
  "query": "用户输入的关键词",
  "topic": "general",
  "search_depth": "basic",
  "max_results": 5,
  "auto_parameters": false,
  "include_answer": false,
  "include_raw_content": false,
  "include_images": false
}
```

`auto_parameters` 可能自动选择 advanced；应用明确使用 basic，避免隐式升级搜索深度。文档中的 `max_results` 范围为 0–20，固定 5 是项目自己的限制。当前公开规范未给出 query 的硬字符上限，应用限长应标为本地约束。[参数依据](https://docs.tavily.com/documentation/api-reference/endpoint/search)

官方按 credits 计量：basic 搜索每次 1 credit，advanced 每次 2 credits。本次不推荐或开通套餐，不调用 Extract、Crawl、Map 或 Research；搜索由用户显式发起，连接中断后不自动重发收费请求。[计量依据](https://docs.tavily.com/documentation/api-credits)

错误响应需转为应用自己的安全提示：401 为密钥无效，429 为限流，432/433 为套餐或按量额度限制；不把服务返回的原始正文直接写入公开日志。搜索结果先展示片段，用户选择后再经受限抓取读取目标页面。[响应依据](https://docs.tavily.com/documentation/api-reference/endpoint/search)

## 解析依赖：已确认的版本与待验事项

项目最低 Node 版本为 22.15。下表来自对应发布版本的 npm 元数据，未修改该最低版本：

| 依赖                   | 建议版本 | 核验结果                                                        |
| ---------------------- | -------- | --------------------------------------------------------------- |
| `@mozilla/readability` | `0.6.0`  | 声明 Node ≥14，附带类型定义；需要外部 DOM。                     |
| `jsdom`                | `29.1.1` | 声明 `^20.19.0 \|\| ^22.13.0 \|\| >=24.0.0`，涵盖 22.15。       |
| `@types/jsdom`         | `28.0.3` | 类型辅助候选；构造与 Document 使用仍需实际 tsc 验证。           |
| `rss-parser`           | `3.13.0` | 附带类型定义，使用 xml2js；没有声明最低 Node 版本，需解析烟测。 |
| `ipaddr.js`            | `2.5.0`  | 声明 Node ≥10，附带类型定义；可辅助统一 IPv4/IPv6 分类。        |

版本元数据：[Readability](https://registry.npmjs.org/@mozilla%2Freadability/0.6.0)、[jsdom 29.1.1](https://registry.npmjs.org/jsdom/29.1.1)、[jsdom 类型](https://registry.npmjs.org/@types%2Fjsdom/28.0.3)、[rss-parser](https://registry.npmjs.org/rss-parser/3.13.0)、[ipaddr.js](https://registry.npmjs.org/ipaddr.js/2.5.0)。

本次查询到的 jsdom 最新版 31.0.1 要求 `^22.22.2 || ^24.15.0 || >=26.0.0`，不适用于现有 Node 22.15。29.1.1 当前所有直接依赖按其 range 解析出的版本，其声明 engines 均兼容 22.15；这不替代完整锁文件和运行验证。jsdom 自身是 CommonJS，但其依赖包含 ESM，因此需在实际 Node 22.15 上验证 `require('jsdom')`、构造 DOM 和 Readability 解析。[29.1.1 发布源码](https://raw.githubusercontent.com/jsdom/jsdom/v29.1.1/package.json)、[31.0.1 元数据](https://registry.npmjs.org/jsdom/31.0.1)

## HTML 与 RSS：事实及实施建议

Mozilla 官方示例使用 `new JSDOM(html, { url })` 提供 DOM。jsdom 默认不执行页面脚本、不加载远程子资源，应保持这些默认设置；不要使用 `JSDOM.fromURL()` 代替项目的受限下载器。提取后只保存标题与纯文本，不把 Readability 返回的 HTML 注入页面。Readability 本身不负责净化 HTML。[Readability 用法与安全说明](https://github.com/mozilla/readability#nodejs-usage)、[jsdom 29.1.1 说明](https://raw.githubusercontent.com/jsdom/jsdom/v29.1.1/README.md)

建议在 `finally` 中关闭 DOM，限制输入字节和元素数。下载超时不能中断同步 DOM 解析，不能把网络超时当成解析 CPU 限额；纯 JS 页面、登录墙或无法识别正文应明确失败，不静默伪造全文。

rss-parser 提供 `parseString` 与 `parseURL`，支持 RSS/Atom 字段归一化；`parseURL` 默认会跟随重定向。项目应只把已受限下载的 XML 传给 `parseString`。RSS 正文可能只是摘要，需要在资料上标明来源；不要因拉取订阅就自动抓取每一个条目的链接。[rss-parser 官方说明](https://github.com/rbren/rss-parser)

建议解析 XML 前拒绝 DTD 和自定义 ENTITY 声明，并约束字节、嵌套、条目数量；保留普通 XML 转义的可读文字。解析库是否支持某类实体不是开放外部实体的授权。

## 公开 URL 下载：建议的应用规则

OWASP 指出，任意外部 URL 场景需同时处理 IP、DNS 和重定向，不能只检查字符串或首个地址。项目需要自己的受限下载器：[SSRF 防护依据](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)。

- 只接受规定的 HTTP/HTTPS 形式，拒绝 URL 中的账号密码及其他协议；页面访问不携带模型、Tavily 或管理员凭据。
- 对主机解析出的全部 IPv4/IPv6 地址检查公网属性，拒绝回环、私网、链路本地和保留地址；连接绑定已检查的地址，避免检查后再次解析造成 DNS 重绑定窗口。
- 禁用自动跳转；若业务允许有限跳转，每跳重新执行 URL、DNS、地址及协议检查，且不转发认证头。
- 限制连接和读取时间、压缩前后字节数及接受的内容类型；无效 TLS 不绕过证书检查。
- 测试例外只允许显式测试模式下、当前模拟服务的精确 loopback origin，不能形成生产环境的通用私网放行开关。

上述是项目建议，仍需通过私网地址、DNS 变更、跨来源跳转、超量内容和 HTML/RSS 恶意输入测试验证。来源 URL、实际跳转后的 URL、获取时间和内容摘要应保留；搜索片段与已采集正文分别表达，AI 请求使用已选择资料的固定快照，避免后续刷新改写历史输入。
