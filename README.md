# Tokenflare - 无服务器 LLM API 网关

**无服务器，适配 Cloudflare Workers 零成本部署的 API 中转站**

一个完全运行在 Cloudflare 免费层上的 **OpenAI 兼容 LLM API 网关**，聚合大语言模型 API Key 分发，支持多用户和收银系统。

![Tokenflare — 在 Cloudflare Workers 上，用一个 OpenAI 兼容 API 统一管理多个 AI 服务 API Key](assets/hero.png)

## 核心特性

- **9 个 AI 提供商，完全 OpenAI 兼容** — Gemini、Mistral、OpenRouter、OpenAI、DeepSeek、Groq、Moonshot (Kimi)、GLM (智谱)、Qwen (阿里云)。一个统一的 `POST /v1/chat/completions` + `GET /v1/models` 端点
- **自愈 Key 池** — 轮询活跃 Key；`401/403`/欠费 → 自动禁用，`429`/限流 → 智能冷却（渐进式退避），成功 → 自动恢复
- **自动降级** — 如果选中的提供商宕机或限流，请求自动透明转发给其他活跃 Key 的提供商（响应头包含 `X-KeyPool-Provider/Model/Fallback`）
- **模型级可用性** — 自动探测 Key 实际支持的模型，隐藏无法使用的模型，用户只能选择真正可用的模型
- **消费者控制台** — 每个 Key（已脱敏）显示状态、统计、最后错误、实时"检测全部"批量检查功能；支持启用/禁用/删除
- **角色 + SSO** — 可选的 OIDC SSO 登录（授权码 + PKCE），管理员审核网关，支持简单的 Bearer Token 认证
- **计量与计费** — 按请求 + 按 Token 统计，每日图表和日志；可选的积分制计费（按模型定价、全局折扣、Token 扣费），支持 Stripe 支付
- **Token 控制** — 单 Token 配额、RPM 限制、过期时间控制
- **内置聊天** — 消费者聊天游乐场（流式响应）和管理员 Key 调试聊天
- **完全免费** — 运行在 Cloudflare Workers + D1 免费层；通过 Cron 或 GitHub Actions 定时健康检查

## 架构

```
客户端 ──▶ Worker (Hono) ──▶ 选择活跃 Key ──▶ 上游提供商
              │                              (Gemini/Mistral/OpenRouter 等)
              ├─ D1: Key、Token、用户、日志
              └─ Cron / POST /admin/probe: 恢复冷却、探测禁用 Key
```

Key 自动恢复：`429`/限流使 Key 进入冷却，`401`/`403` 禁用 Key，两者都能自动恢复（成功重试时或通过 Cron/`/admin/probe`）。

## 快速开始

详细的部署步骤请参考 [AGENTS.md](AGENTS.md)。

> **用 AI Agent 自动化部署？** 
> 
> 请阅读完整的 [AI Agent 自动化部署教程](https://opcgrow.org/article.php?id=137)

## API 核心端点

| 方法 & 路径 | 认证 | 用途 |
|---|---|---|
| `POST /v1/chat/completions` | 用户 Token / 会话 | OpenAI 兼容聊天 |
| `GET /v1/models` | 用户 Token / 会话 | 列出可用模型 |
| `POST /admin/keys/import` | 管理员 | 批量导入 `provider:key` |
| `GET /admin/keys/list` | 管理员 | 所有 Key + 统计 |
| `POST /admin/keys/:id/check` | 管理员 | 实时 Key 检测 / 余额探测 |
| `GET/POST/DELETE /me/tokens` | 会话 | 消费者自助管理 Token |
| `GET /admin/usage` `/admin/logs` `/me/usage` `/me/logs` | 管理员 / 会话 | 计量统计 |
| `GET /admin/balances` `POST /admin/balances/:sub/topup` | 管理员 | 计费管理 |
| `POST /me/checkout` | 会话 | Stripe 积分充值 |

## 使用示例

### 导入 API Key

```bash
curl https://YOUR_WORKER/admin/keys/import \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"keys":"gemini:AIza...\nmistral:...\nopenrouter:sk-or-v1-..."}'
```

### 发送聊天请求

```bash
curl https://YOUR_WORKER/v1/chat/completions \
  -H "Authorization: Bearer <user-token>" \
  -H 'content-type: application/json' \
  -d '{"model":"mistral-small-latest","messages":[{"role":"user","content":"你好"}]}'
```

## 重要说明

- **服务条款** — 聚合/共享/转售提供商 API Key 可能违反上游提供商的服务条款。请用此项目汇聚**自己的** Key，并在向他人公开前仔细阅读各提供商的使用条款。
- **SSO 可选** — 不设置 `OIDC_*` 环境变量时，将以 `ADMIN_TOKEN` + 生成的 Token 模式运行。

## 授权

MIT

---

**📚 完整的 AI Agent 自动化部署教程：** [https://opcgrow.org/article.php?id=137](https://opcgrow.org/article.php?id=137)
