# 早日发Paper

一个英文翻译的阅读器。完全免费、开源。

当前源码接入 MinerU，以及云端 API、本地大模型和免费 Edge免费 翻译。

## 运行

普通用户可使用仓库 Releases 中的 Windows 便携压缩包：完整解压后运行 `早日发Paper.exe`。

## 使用流程

1. 默认使用免费的 Edge 翻译，无需密钥。
2. 文档解析配置填写 MinerU Token。翻译配置填写兼容 OpenAI Chat Completions 的服务地址、API Key、模型名称、语言和可选术语偏好。云端服务可能产生调用费用。
  
## 源文件

| 文件 | 用途 |
| --- | --- |
| `main.mjs` | Electron 桌面入口、本地存储、MinerU/翻译请求、任务与导出 |
| `document.mjs` | Markdown 语法树、内容块、译文回填和校验 |
| `files.mjs` | 支持 Windows 短暂文件占用的原子保存、受大小限制的 ZIP 读取 |
| `translation-queue.mjs` | 阅读段落队列、去重与优先级 |
| `translation.mjs` | 统一批量规则、请求估算、缓存复用与译文回填 |
| `translation-timeout.mjs` | 超时强停与立即取消 |
| `translation-rate-limit.mjs` | 云端入口共用的可配置请求间隔，0 表示不额外等待 |
| `references.mjs` | 中英文图表公式编号、对象索引及跳转候选 |
| `preload.cjs` | 限定的页面调用接口 |
| `index.html`、`style.css`、`renderer.js` | 阅读器与设置界面 |
| `sample.md` | 离线可打开的示例 |


## 参考

- [MinerU API 文档](https://mineru.net/apiManage/docs)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [KaTeX 表格内公式渲染](https://katex.org/docs/autorender.html)

本项目许可证见 `LICENSE`，第三方依赖按各自许可证使用；

## 作者

软件的作者是国富贵儿，苦于看不懂英文，特此开发此软件。如有需求建议可以通过以下方式联系到我1919429703@qq.com。祝您天天开心
