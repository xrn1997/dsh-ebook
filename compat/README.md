# compat：真实源回放与跑通率报告

**compat 跑通率是 v1 的验收标准本身**——本目录把「率」变成可一键复算的数字（验收口径与三条真链路门控的承诺边界见 [`docs/design/services.md`](../docs/design/services.md) 的「构建、装载与验收」节）。

> **分母口径（别误读）**：`compat/report.md` 的「跑通率」分母是 `compat/fixtures/` 下的 fixture。
> 当前树只有 **1 条手写合成 fixture**（`demo-site`，域名 `demo.local` 不存在）——它是**规则引擎离线
> 回放的回归基线**，**不代表任何真实站点兼容率**（不覆盖真实 HTTP/重定向、GBK、超时、反爬、@js 真实宿主）。
> `compat/sources/` 目前为空；站点可用率请用真机重探（`DSH_REPROBE=1`）或投放真实源后走下面三步闭环。

## 三步闭环

1. **投放源**：把 legado 书源 JSON 放进 `compat/sources/*.json`（一源一文件）。
2. **采集**（会真联网；每条源耗时 = 站点响应速度）：

   ```powershell
   $env:COMPAT_CAPTURE='1'
   pnpm vitest run --config vitest.compat.config.ts tests/compat/capture.test.ts
   Remove-Item Env:\COMPAT_CAPTURE
   ```

   关键词用 `$env:COMPAT_KEYWORD='剑来'` 覆盖（默认「书」）；**采集与回放必须同关键词**（manifest 已记）。
   GBK 源 v1 采集直接失败（fixture 只存 utf8 原文，不静默转码——解码链 compat 化等二进制快照格式再排期）。

3. **复算跑通率**（离线）：`pnpm test:compat` → 逐源断言 + 生成 `compat/report.md`（总计/失败原因分布/逐源明细）。

三步闭环均已实现（采集侧门控测试 `tests/compat/capture.test.ts`）。数字从第一条采集的源开始才有意义——`compat/sources/` 当前为空。

## 目录结构

```
compat/
├── sources/                 # 投放的源 JSON（不强制入库）
├── fixtures/<caseName>/     # 采集产物：source.json 快照 + manifest.json + pages/
└── report.md                # test:compat 生成（覆盖写）
```

## 脱敏规程（入库门禁）

自动两刀（capture 写盘前执行）：① password input 的 value 值 → `[REDACTED]`；② `(cookie|token|password|passwd|secret)\s*[:=]\s*["'][^"']{8,}["']` → `[REDACTED]`。

**自动脱敏是兜底不是证明**：入库前人工过目；禁止提交含真实 cookie 的 fixture。
