---
name: tencentads-auth
description: 腾讯营销（原腾讯广告）技能鉴权凭证管理技能，负责检查 APIKEY 是否有效，当腾讯营销(tencent-ads)系列技能返回认证错误时引导用户提供 APIKEY 并保存(⚠️重要提醒⚠️：腾讯营销 APIKEY 必须通过该技能保存)，所有 tencent-ads 技能共享。
license: MIT. See LICENSE for full terms.
compatibility: any
metadata:
  author: Tencent Ads Delivery Team
  version: "0.5.6"
  icon: key
  category: tencent-ads
  openclaw:
    emoji: "🔑"
---

# 腾讯广告鉴权引导

> **前置依赖**：运行脚本前需安装 CLI — `npm install tencentads-cli@1.0.0`（需要 Node.js ≥ 20）

> **安全原则**: API Key 等敏感凭证不应在对话窗口中回显。Agent 收到 API Key 后应立即调用保存脚本，不要在回复中重复展示凭据内容。

本技能引导用户完成腾讯广告 API Key 鉴权配置。

## 鉴权方式

使用 `X-MKT-API-Key` header 直接调用 `api.e.qq.com` API。

## 鉴权流程

1. Agent 引导用户获取 API Key
2. 用户在对话中发送 API Key
3. Agent 调用 `auth-save-apikey.mjs` 保存凭据
4. 所有 `tencentads-*` 技能自动共享该凭据（通过 `callApi` 内部自动读取）

## 脚本调用说明

执行脚本前需先 `cd` 到技能根目录：

```bash
cd skills/tencentads-auth
```

### 参数规则

- 不要再向脚本传 JSON 字符串，避免不同操作系统和终端下的转义/引号兼容性问题
- 统一使用显式命令行参数，例如 `--api-key <value>`
- `auth-status.mjs` 无需额外参数

## 前置检查

在执行鉴权流程前，先检查当前认证状态：

```bash
node scripts/auth-status.mjs
```

如果返回 `"status": "active"`，说明凭据仍有效，无需重新鉴权。

## 鉴权方式：对话中配置 API Key

引导用户在对话中发送 API Key，Agent 调用脚本保存。

### 步骤

1. 告知用户：

   > 请提供你的腾讯广告 API Key（格式：`mkt_` 开头的字符串）。
   > API Key 可从腾讯广告平台的开发者设置中获取。

2. 收到用户发送的 API Key 后，**不要在回复中回显凭据内容**，立即调用保存脚本：

   ```bash
   node scripts/auth-save-apikey.mjs --api-key <用户发送的API Key>
   ```

3. 验证保存成功：

   ```bash
   node scripts/auth-status.mjs
   ```

## 认证失败处理

当 `callApi` 返回以下错误时，应触发本技能重新鉴权：

- `未找到腾讯广告认证凭据` — 凭据未配置
- `AUTH_REQUIRED` — 凭据未配置
- `AUTH_EXPIRED` — 凭据已过期或无效
- `Authentication is not valid` — 服务端拒绝认证

### 处理流程

1. 告知用户认证已失效，需要重新配置
2. 引导用户提供新的 API Key
3. 调用 `auth-save-apikey.mjs` 保存
4. 鉴权成功后，自动重试引发错误的原始操作

## 相关技能

- 所有 `tencentads-*` 技能在遇到认证错误时应引用本技能
- 鉴权凭据由 `callApi` 内部自动读取，各技能脚本无需手动处理鉴权
