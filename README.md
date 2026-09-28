# Tokenflare：开源 Token 中转站

适配 **Cloudflare Workers** 的开源、无服务器 OpenAI 兼容 LLM API 网关。无需购买服务器，使用 Cloudflare Workers + D1 即可实现 **0 成本部署（以 Cloudflare 免费额度及上游服务政策为准）**，适合个人搭建自己的 AI API 中转服务。

> 📖 **详细部署教程**：<https://opcgrow.org/article.php?id=155>
>
> 本项目支持长期运行；实际可用性取决于 Cloudflare 免费额度、上游 API 服务商政策和账号状态。

## 项目介绍

Tokenflare 可以将多个 AI 服务商的 API Token 统一接入，并通过一个稳定的 OpenAI 兼容接口对外提供服务。你可以在 Cloudflare 上部署属于自己的 Token 中转站，不需要服务器、Redis 或 R2。

项目基于 Hono、Cloudflare Workers 和 D1 构建，数据存储在 Cloudflare D1 数据库中，适合低成本、轻量化部署。

## 主要功能

- **OpenAI 兼容接口**：提供 `POST /v1/chat/completions` 和 `GET /v1/models`，可直接接入支持 OpenAI API 格式的客户端。
- **多上游服务商支持**：支持 Gemini、Mistral、OpenRouter、OpenAI、DeepSeek、Groq、Moonshot（Kimi）、GLM（智谱）、Qwen（通义千问）等服务商。
- **多 Token 统一管理**：将多个上游 Token 放入密钥池，统一导入、查看、启用、禁用和删除。
- **自动故障转移**：当前服务商或 Token 不可用时，自动切换到其他可用 Token 或服务商，提升接口可用性。
- **密钥池自动自愈**：遇到 `401/403` 等无效密钥会自动禁用；遇到 `429` 或额度限制会进入冷却，并通过重试和定时探测自动恢复。
- **模型可用性检测**：探测 Token 实际可调用的模型，避免用户选择无法使用的模型。
- **管理后台**：查看 Token 状态、调用统计、错误信息，支持批量检测和管理。
- **用户与权限管理**：支持管理员 Token 鉴权，也可选配 OIDC 单点登录（SSO）和用户审批。
- **用量统计**：记录请求量、Token 用量、调用日志，并提供管理端和用户端统计页面。
- **可选计费功能**：支持按模型和 Token 用量计费、余额扣除及 Stripe 充值（需要自行配置相关密钥）。
- **Token 控制**：支持用户 Token 的额度、每分钟请求数（RPM）和有效期设置。
- **内置聊天控制台**：提供用户聊天 playground 和管理员调试聊天功能。
- **Cloudflare 原生部署**：基于 Workers + D1，无需维护服务器，支持通过 Cron 或 GitHub Actions 进行健康检查。

## 部署教程

### 1. 准备环境

请确保已安装：

- Node.js 18 或更高版本
- npm
- Cloudflare 账号
- Wrangler CLI 登录权限

登录 Cloudflare：

```bash
npx wrangler login
npx wrangler whoami
```

### 2. 安装依赖并初始化数据库

在项目目录执行：

```bash
npm install
npm run setup
```

`npm run setup` 会自动创建或复用 D1 数据库 `llm-gateway`，回填本地 `wrangler.toml`，并应用项目所需的数据库结构。

如果你不使用自动化脚本，也可以手动执行：

```bash
npx wrangler d1 create llm-gateway
cp wrangler.toml.example wrangler.toml
# 将创建结果中的 database_id 填入 wrangler.toml
npx wrangler d1 execute llm-gateway --remote --file=./schema.sql
```

> `wrangler.toml` 通常包含本地部署配置，请勿将包含真实数据库 ID 或敏感配置的文件提交到公开仓库。

### 3. 设置管理员密钥

管理员密钥用于登录后台和调用管理 API，建议使用随机字符串：

```bash
openssl rand -hex 24
npx wrangler secret put ADMIN_TOKEN
```

执行第二条命令后，将刚才生成的随机字符串粘贴进去。

### 4. 部署 Worker

```bash
npm run deploy
```

也可以直接执行：

```bash
npx wrangler deploy
```

部署成功后，Wrangler 会输出一个 `*.workers.dev` 地址。打开该地址即可进入管理控制台，并使用 `ADMIN_TOKEN` 进行登录。

### 5. 导入上游 Token

登录管理后台后，可批量导入上游 Token。也可以使用管理 API：

```bash
curl https://你的-worker地址.workers.dev/admin/keys/import \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"keys":"gemini:AIza...\nmistral:...\nopenrouter:sk-or-v1-..."}'
```

导入格式为每行一个 `provider:key`，例如：

```text
gemini:AIza...
mistral:...
openrouter:sk-or-v1-...
```

### 6. 调用接口

导入 Token 后，即可通过 OpenAI 兼容接口调用：

```bash
curl https://你的-worker地址.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <用户Token>" \
  -H "content-type: application/json" \
  -d '{
    "model":"mistral-small-latest",
    "messages":[{"role":"user","content":"你好"}]
  }'
```

## 可选配置

在 `wrangler.toml` 的 `[vars]` 中可以配置以下变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `COOLDOWN_MINUTES` | `3` | Token 遇到限流或配额错误后的冷却时间 |
| `MAX_KEY_RETRIES` | `4` | 单次请求最多尝试的 Token 数量 |
| `PROBE_INTERVAL_MINUTES` | `60` | 健康探测间隔 |
| `BILLING_ENABLED` | 空 | 设置为 `1` 开启余额计费 |
| `BRAND_NAME` | — | 管理台品牌名称 |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` | — | OIDC SSO 配置 |
| `ADMIN_EMAIL` | — | 指定管理员邮箱 |
| `DEFAULT_PRICE_MICRO` | `500000` | 未定价模型的默认价格 |
| `DISCOUNT` | `1` | 全局价格折扣 |
| `PUBLIC_BASE_URL` / `CURRENCY` | — | 支付跳转地址和货币配置 |

如需启用 SSO，还需要设置：

```bash
npx wrangler secret put SESSION_SECRET
```

如需启用 Stripe 计费，还需要设置：

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

## 常用接口

| 方法与路径 | 用途 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容聊天补全 |
| `GET /v1/models` | 获取可用模型列表 |
| `POST /admin/keys/import` | 批量导入上游 Token |
| `GET /admin/keys/list` | 查看 Token 和状态 |
| `POST /admin/keys/:id/check` | 检测单个 Token |
| `POST /admin/check-all-keys` | 批量检测全部 Token |
| `POST /admin/keys/:id/enable` | 启用 Token |
| `POST /admin/keys/:id/disable` | 禁用 Token |
| `DELETE /admin/keys/:id` | 删除 Token |
| `GET /admin/usage` | 查看管理员用量统计 |
| `GET /me/usage` | 查看用户用量统计 |

## 注意事项

- 请仅使用你拥有或获得合法授权的上游 API Token，并遵守 Cloudflare 及各上游服务商的服务条款。
- 不同服务商的免费额度、速率限制和计费规则可能变化，项目的“0 成本”仅指软件部署无需额外服务器成本，不代表上游 API 永久免费。
- 请妥善保管 `ADMIN_TOKEN`、上游 Token 和支付密钥，不要将其提交到公开仓库或发送给他人。
- Cloudflare Workers、D1 及上游服务均受各自的额度和政策限制；如需面向大量用户提供服务，请提前评估稳定性、合规性和成本。

## 开源协议

MIT License
