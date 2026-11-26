# learn-language-relay（邀请码中转）

让朋友不用申请自己的 Gemini API Key，凭**邀请码**就能使用站长的额度。

- 真正的 `GEMINI_API_KEY` 只存在 Cloudflare 的 secret 里，**永远不会发到浏览器**。
- **实时对话**：Worker 为每次练习签发一个**一次性临时令牌**（ephemeral token，`uses: 1`），浏览器拿着令牌直连 Gemini Live。音频不经过 Worker，延迟不受影响。令牌 2 分钟内必须开始使用，并在本次授予的分钟数加 1 分钟后过期。
- **老师点评 / 语音合成 / 总结**：经 Worker 代理 `generateContent`。
- 有自己 Key 的用户仍然可以在网页设置里填自己的 Key，这时完全不经过 Worker。

## 限额

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEVICE_DAILY_MINUTES` | 30 | 每台设备每天可练习的分钟数 |
| `TOTAL_DAILY_MINUTES` | 120 | 全站每天的总分钟数（控制总花费） |
| `SESSION_MAX_MINUTES` | 15 | 单次练习上限（Live API 音频会话本身也约 15 分钟） |
| `DEVICE_DAILY_REQUESTS` | 400 | 每台设备每天的点评/语音请求次数上限 |

日期按 **UTC** 计算，北京时间每天早上 8 点重置。

**分钟计费方式**：开始练习时先预留本次可用的分钟数（最多 15 分钟，且不超过当天剩余额度），结束时网页上报实际用时，没用完的会退回。上报用时不能少于“从签发令牌到上报”的真实时间减 1 分钟。如果浏览器崩溃或直接关掉、没来得及上报，预留的分钟就按用完计算（偏保守，不会多花钱）。

其他保护：
- 邀请码比较使用常量时间；同一 IP 每分钟输错超过 10 次会被临时拒绝。
- 每台设备每分钟最多 40 次点评请求（Cloudflare Rate Limiting，不占 KV 写入额度）。
- 模型名只允许 `gemini-...` 格式，请求体最大 4MB。
- CORS 只放行 `ALLOWED_ORIGINS` 里的网址。
- `INVITE_CODE` 可以用英文逗号分隔多个，比如给不同朋友不同的码，想停掉某个人时删掉他那个码就行。

KV 写入很省：每次练习约 6 次写入；点评请求用概率计数，平均每 10 次请求写 1 次。Cloudflare 免费版每天 1000 次写入，朋友间使用足够。

## 部署（在 `app/` 目录下执行）

```bash
# 1. 登录 Cloudflare（会打开浏览器）
npx wrangler login

# 2. 创建 KV，把输出里的 id 填进 worker/wrangler.toml 的 [[kv_namespaces]] id
npx wrangler kv namespace create USAGE --config worker/wrangler.toml

# 3. 设置两个 secret（按提示粘贴，不会写进任何文件）
npx wrangler secret put GEMINI_API_KEY --config worker/wrangler.toml
npx wrangler secret put INVITE_CODE --config worker/wrangler.toml

# 4. 部署
npm run worker:deploy
```

部署成功后会得到一个地址，比如 `https://learn-language-relay.<你的子域>.workers.dev`。把它填进 `src/lib/config.js` 的 `RELAY_URL`（也可以在构建时设置环境变量 `VITE_RELAY_URL`），然后提交并 push，GitHub Pages 会自动重新部署。

改限额：编辑 `worker/wrangler.toml` 的 `[vars]` 后重新 `npm run worker:deploy`。
改邀请码：重新执行 `npx wrangler secret put INVITE_CODE --config worker/wrangler.toml`（立即生效）。

## 本地测试

在 `worker/.dev.vars` 里写假的 secret（这个文件已被 gitignore）：

```
GEMINI_API_KEY="..."
INVITE_CODE="test-code"
```

然后执行 `npm run worker:dev`。

## 如果实时对话连不上

临时令牌目前走 `v1beta` 的 `BidiGenerateContentConstrained` 接口。如果 Google 改了接口版本，把 `wrangler.toml` 里的 `LIVE_API_VERSION` 改成 `v1alpha` 再重新部署试试。
