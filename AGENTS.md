# AGENTS.md — AI 部署指南（Tokenflare / cloudflare-llm-gateway）

> 给自动部署 agent 看的确定性执行清单。照单执行，不要猜。

## 0. 前置条件

- Node.js 18+，已 `npm install`
- Cloudflare 账号已登录：`npx wrangler whoami`（未登录先 `npx wrangler login`）
- Token 权限（API Token 需勾选）：**Workers Scripts Edit、Workers D1 Edit、Workers KV Storage Edit（本仓库未用，可略）、Account Settings Read**；部署本身用 `wrangler login`（OAuth）或 `CLOUDFLARE_API_TOKEN` 环境变量亦可
- 本仓库不依赖 R2 / Queues / Workers AI

## 1. 快速部署（三步）

```bash
npm install
npm run setup          # 建/复用 D1 `llm-gateway` → 回填 wrangler.toml → 应用 schema.sql
npm run deploy         # npx wrangler deploy
```

部署后打开输出的 `*.workers.dev` 地址，用 `ADMIN_TOKEN` 登录管理台并导入上游密钥。

## 2. Secrets 清单

| 变量 | 必填 | 干什么 | 获取方式 | 不填时行为 |
|---|---|---|---|---|
| `ADMIN_TOKEN` | ✅ 必填 | 管理后台/API 的 Bearer Token | 自行生成（`openssl rand -hex 24`） | 管理功能全部 401 |
| `SESSION_SECRET` | 仅 SSO | 签名 SSO 会话/PKCE cookie，32+ 字节 | 自行生成 | SSO 登录关闭（降级为仅 ADMIN_TOKEN） |
| `STRIPE_SECRET_KEY` | 仅计费 | Stripe 服务端密钥 | Stripe Dashboard | 在线充值入口隐藏（其余功能正常） |
| `STRIPE_WEBHOOK_SECRET` | 仅计费 | 校验 Stripe webhook 签名 | Stripe Dashboard | 充值回调不生效 |

设置：`npx wrangler secret put <名字>`（逐个执行）。

### Vars（wrangler.toml `[vars]`，非密钥，可直接改）

| 变量 | 默认 | 说明 |
|---|---|---|
| `COOLDOWN_MINUTES` | `3` | 429/配额后 key 冷却分钟数 |
| `MAX_KEY_RETRIES` | `4` | 单请求最多尝试的池内 key 数 |
| `PROBE_INTERVAL_MINUTES` | `60` | cron 探测间隔 |
| `BILLING_ENABLED` | 空 | `"1"` 开启信用余额计费 |
| `BRAND_NAME` / `SSO_LABEL` / `SSO_NOTE` | — | 控制台品牌文案（可选） |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `ADMIN_EMAIL` | — | SSO（OIDC）配置；`ADMIN_EMAIL` 对应邮箱登录即管理员 |
| `DEFAULT_PRICE_MICRO` | `500000` | 未定价模型的回退价格（micro-USD / 1M tokens） |
| `DISCOUNT` | `1` | 全局售价折扣（`0.1` = 1 折） |
| `SIGNUP_BONUS_USD` | — | 新用户一次性赠送余额（USD） |
| `PUBLIC_BASE_URL` / `CURRENCY` | — | Stripe 跳转基址 / 币种（默认 usd） |
| `TRANSACTION_RETENTION_DAYS` / `PENDING_ORDER_RETENTION_DAYS` / `LOG_RETENTION_DAYS` | 90/30/30 | 数据保留天数（cron 清理） |

## 3. 常见报错对照表

| 报错 | 原因 | 处理 |
|---|---|---|
| `Missing api_token` / `Could not find account` | 未登录 | `npx wrangler login` 或导出 `CLOUDFLARE_API_TOKEN` |
| `D1: database does not exist` | 没跑 setup | `npm run setup`（自动创建） |
| `table keypool_gateway_users already exists` | schema 重复执行 | 幂等可忽略；若需清库：先 `wrangler d1 delete llm-gateway` 再 `npm run setup` |
| `401` 访问管理台 | `ADMIN_TOKEN` 未设置或不匹配 | `npx wrangler secret put ADMIN_TOKEN` |
| `SSO not configured` (503) | 启用了 SSO 页面但没配齐 | 填齐 `OIDC_ISSUER`+`OIDC_CLIENT_ID`+`SESSION_SECRET`，或仅用 ADMIN_TOKEN |
| 上游 `401/403` 后 key 被自动禁用 | 上游密钥失效 | 管理台 `检测全部` / `POST /admin/check-all-keys` 会重新探测复活 |
| cron 触发数超免费额度(5) | 免费计划限制 | 删掉 `[triggers]`，改用外部 pinger 定时 `POST /admin/sweep`（见 `.github/workflows/keypool-health.yml`） |

## 4. 项目结构速览

```
src/
  index.ts         入口：Hono 路由装配 + /manifest.json + /sw.js + cron
  types.ts         Env 类型与 Provider 契约（不要改签名）
  db.ts            D1 数据访问层 + 建表/设置
  keypool.ts       密钥池：自愈、冷却退避、复活
  probe.ts         探测（1-token liveness / 余额 / 模型可用性）
  oidc.ts          SSO 登录（OIDC PKCE）+ 邮箱验证码 + 会话
  auth.ts          Bearer Token 鉴权
  chat.ts          /v1 流式与普通补全（OpenAI 兼容）
  payone.ts        易支付（第三方收款）轮询对账
  smtp.ts          SMTP 发信（QQ 邮箱等，配置存 settings 表）
  ui.ts            内嵌管理/用户控制台（单文件 HTML）
  i18n.ts          中英文界面文案
  routes/          admin.ts / me.ts / openai.ts / passthrough.ts / pay.ts
  providers/       各上游 provider 适配（gemini/mistral/…/channel 手动通道）
schema.sql         D1 初始 schema（npm run setup 自动应用）
migration-*.sql    增量迁移（已在生产库执行过，勿重复跑）
wrangler.toml      本地真实配置（已被 .gitignore 排除，不入库）
wrangler.toml.example  入库模板（database_id 占位）
admin.ps1          管理 CLI（读取 .admin-token.txt；URL 占位需替换）
deploy.sh          一行部署脚本（幂等）
```

## 5. 安全与隐私检查

```bash
npm run scan:secrets   # 全盘敏感模式扫描（node scripts/formal_secret_scan.mjs）
```

- 密钥一律走 `wrangler secret put`，**不要**写进 `wrangler.toml` 或代码
- `wrangler.toml`、`.admin-token.txt`、`.session-secret.txt` 已被 `.gitignore` 排除，勿强推
- 数据库里存的 keys/tokens 均为密文哈希或待用池密钥，管理台 API 已做脱敏

## 6. 部署后自检

1. `GET https://<worker>/healthz` → `{"ok":true}`
2. 管理台登录 → 导入 `provider:key` 行 → `检测全部` 应全部 active
3. `POST /v1/chat/completions` 用用户 token 调用一个模型，观察响应头 `X-KeyPool-*`
