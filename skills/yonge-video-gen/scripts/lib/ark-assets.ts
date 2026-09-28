/**
 * 方舟 AIGC 素材（asset://）流程。
 *
 * 为什么需要它：方舟视频接口拒绝直接上传含真人人脸的参考图，只接受素材库里已授权的
 * asset://<id>。而 CreateAsset 只吃可公网访问的 HTTPS URL，不吃 Data URL，所以本地图片
 * 必须先落到对象存储（这里用腾讯 COS，凭证与方舟 AK/SK 同放 ~/.yonge/.yonge-skills/.env）
 * 拿到带签名的 URL，再交给方舟建素材，轮询到 Active 才能用。
 *
 * 完整链路：本地图 → COS(PUT, 预签名 GET) → CreateAssetGroup/ListAssetGroups → CreateAsset → GetAsset 轮询 → asset://<id>
 */
import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isArkAssetUri, isRemoteUrl, mimeTypeFor } from "./media";

const OPENAPI_HOST = "open.volcengineapi.com";
const OPENAPI_REGION = "cn-beijing";
const OPENAPI_SERVICE = "ark";
const OPENAPI_VERSION = "2024-01-01";
const ASSET_GROUP_NAME = "yonge-video-gen";
const ASSET_POLL_INTERVAL_MS = 3000;
const ASSET_POLL_ATTEMPTS = 60;

export type ArkCredentials = {
  accessKey?: string;
  secretKey?: string;
  projectName?: string;
  assetGroupId?: string;
};

export type CosCredentials = {
  secretId?: string;
  secretKey?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  domain?: string;
};

export type YongeCredentials = { ark: ArkCredentials; tencentCos: CosCredentials };

/** 同一次运行内复用素材组，避免每张图都打一次 ListAssetGroups。 */
const groupCache = new Map<string, string>();
let credentialsPromise: Promise<YongeCredentials> | null = null;

/**
 * 从 ~/.yonge/.yonge-skills/.env 与项目级 .yonge/.yonge-skills/.env 读 COS 凭证；
 * 方舟 AK/SK/COS 环境变量优先级更高，便于 CI 或临时覆盖。
 */
export async function loadYongeCredentials(): Promise<YongeCredentials> {
  credentialsPromise ||= (async () => {
    const result: YongeCredentials = { ark: {}, tencentCos: {} };

    const take = (name: string): string | undefined => {
      const value = process.env[name]?.trim();
      return value ? value : undefined;
    };

    result.tencentCos.secretId ||= take("TENCENT_COS_SECRET_ID");
    result.tencentCos.secretKey ||= take("TENCENT_COS_SECRET_KEY");
    result.tencentCos.region ||= take("TENCENT_COS_REGION");
    result.tencentCos.bucket ||= take("TENCENT_COS_BUCKET");
    result.tencentCos.prefix ||= take("TENCENT_COS_PREFIX");
    result.tencentCos.domain ||= take("TENCENT_COS_DOMAIN");

    // 环境变量优先级最高，其次才是 .env 文件
    result.ark.accessKey = process.env.ARK_ACCESS_KEY?.trim() || process.env.VOLC_ACCESSKEY?.trim() || result.ark.accessKey;
    result.ark.secretKey = process.env.ARK_SECRET_KEY?.trim() || process.env.VOLC_SECRETKEY?.trim() || result.ark.secretKey;
    result.ark.projectName = process.env.ARK_PROJECT_NAME?.trim() || result.ark.projectName;
    result.ark.assetGroupId = process.env.ARK_ASSET_GROUP_ID?.trim() || result.ark.assetGroupId;
    return result;
  })();
  return credentialsPromise;
}

/**
 * 把一张参考图变成 asset:// 引用。
 * 已经是 asset:// 就原样返回；已有公网 HTTPS URL 就跳过 COS 直接建素材。
 */
export async function resolveArkImageAsset(imagePath: string): Promise<string> {
  if (isArkAssetUri(imagePath)) return imagePath;

  const credentials = await loadYongeCredentials();
  const sourceUrl = /^https:\/\//i.test(imagePath) ? imagePath : await uploadImageToCos(imagePath, credentials.tencentCos);
  const projectName = credentials.ark.projectName?.trim() || "default";
  const groupId = await ensureAssetGroup(credentials.ark, projectName);

  const created = await callArkAssetApi<{ Id?: string }>(credentials.ark, "CreateAsset", {
    GroupId: groupId,
    URL: sourceUrl,
    AssetType: "Image",
    Name: path.basename(imagePath) || "yonge-video-reference",
    ProjectName: projectName,
  });
  if (!created.Id) throw new Error("方舟素材创建失败：响应缺少素材 ID");
  return waitForAsset(credentials.ark, created.Id, projectName);
}

async function ensureAssetGroup(credentials: ArkCredentials, projectName: string): Promise<string> {
  const configured = credentials.assetGroupId?.trim();
  if (configured) return configured;

  const cacheKey = `${credentials.accessKey || ""}:${projectName}`;
  const cached = groupCache.get(cacheKey);
  if (cached) return cached;

  const listed = await callArkAssetApi<{ Items?: Array<{ Id?: string }> }>(credentials, "ListAssetGroups", {
    Filter: { Name: ASSET_GROUP_NAME, GroupType: "AIGC" },
    PageNumber: 1,
    PageSize: 10,
    ProjectName: projectName,
  });
  const existing = listed.Items?.find((item) => item.Id)?.Id;
  if (existing) {
    groupCache.set(cacheKey, existing);
    return existing;
  }

  const created = await callArkAssetApi<{ Id?: string }>(credentials, "CreateAssetGroup", {
    Name: ASSET_GROUP_NAME,
    Description: "yonge-video-gen 自动上传的参考素材",
    GroupType: "AIGC",
    ProjectName: projectName,
  });
  if (!created.Id) throw new Error("方舟素材组创建失败：响应缺少组 ID");
  groupCache.set(cacheKey, created.Id);
  return created.Id;
}

async function waitForAsset(credentials: ArkCredentials, assetId: string, projectName: string): Promise<string> {
  for (let attempt = 0; attempt < ASSET_POLL_ATTEMPTS; attempt += 1) {
    const asset = await callArkAssetApi<{ Status?: string; Error?: { Message?: string } }>(credentials, "GetAsset", {
      Id: assetId,
      ProjectName: projectName,
    });
    if (asset.Status === "Active") return `asset://${assetId}`;
    if (asset.Status === "Failed") throw new Error(asset.Error?.Message || "方舟素材处理失败");
    await new Promise((resolve) => setTimeout(resolve, ASSET_POLL_INTERVAL_MS));
  }
  throw new Error("方舟素材处理超时（3 分钟未变为 Active）");
}

type ArkEnvelope<T> = { Result?: T; ResponseMetadata?: { Error?: { Code?: string; Message?: string } } };

async function callArkAssetApi<T>(credentials: ArkCredentials, action: string, body: Record<string, unknown>): Promise<T> {
  if (!credentials.accessKey?.trim() || !credentials.secretKey?.trim()) {
    throw new Error("缺少方舟 AK/SK。请在 ~/.yonge/.yonge-skills/.env 中配置 ARK_ACCESS_KEY / ARK_SECRET_KEY，或设置同名环境变量");
  }
  const payload = JSON.stringify(body);
  const query = `Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(OPENAPI_VERSION)}`;
  const headers = signArkRequest(credentials.accessKey.trim(), credentials.secretKey.trim(), action, payload);

  const response = await fetch(`https://${OPENAPI_HOST}/?${query}`, { method: "POST", headers, body: payload });
  const text = await response.text();
  let parsed: T | ArkEnvelope<T>;
  try {
    parsed = JSON.parse(text) as T | ArkEnvelope<T>;
  } catch {
    throw new Error(`方舟素材接口返回非 JSON（${response.status}）：${text.slice(0, 200)}`);
  }
  if (parsed && typeof parsed === "object" && "ResponseMetadata" in parsed) {
    const envelope = parsed as ArkEnvelope<T>;
    const error = envelope.ResponseMetadata?.Error;
    if (error) throw new Error(`方舟素材接口错误 ${error.Code || ""}: ${error.Message || "未知错误"}`);
    if (envelope.Result === undefined) throw new Error("方舟素材接口返回为空");
    return envelope.Result;
  }
  if (!response.ok) throw new Error(`方舟素材接口失败（${response.status}）：${text.slice(0, 200)}`);
  return parsed as T;
}

/** 火山引擎 OpenAPI V4 签名（HMAC-SHA256）。签名串各段顺序与换行都不能动。 */
function signArkRequest(accessKey: string, secretKey: string, action: string, payload: string): Record<string, string> {
  const xDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${OPENAPI_HOST}\nx-content-sha256:${payloadHash}\nx-date:${xDate}\n`;
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalQuery = `Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(OPENAPI_VERSION)}`;
  const canonicalRequest = ["POST", "/", canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${shortDate}/${OPENAPI_REGION}/${OPENAPI_SERVICE}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const dateKey = createHmac("sha256", secretKey).update(shortDate).digest();
  const regionKey = createHmac("sha256", dateKey).update(OPENAPI_REGION).digest();
  const serviceKey = createHmac("sha256", regionKey).update(OPENAPI_SERVICE).digest();
  const requestKey = createHmac("sha256", serviceKey).update("request").digest();
  const signature = createHmac("sha256", requestKey).update(stringToSign).digest("hex");

  return {
    "Content-Type": "application/json",
    Host: OPENAPI_HOST,
    "X-Content-Sha256": payloadHash,
    "X-Date": xDate,
    Authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 上传到腾讯 COS，返回带 2 小时预签名的可读 URL——方舟 CreateAsset 需要能直接 GET 到图。 */
async function uploadImageToCos(imagePath: string, credentials: CosCredentials): Promise<string> {
  if (!credentials.secretId || !credentials.secretKey || !credentials.region || !credentials.bucket) {
    throw new Error("参考图缺少公网 URL，且腾讯 COS 配置不完整。请在 ~/.yonge/.yonge-skills/.env 中补齐 TENCENT_COS_SECRET_ID/TENCENT_COS_SECRET_KEY/TENCENT_COS_REGION/TENCENT_COS_BUCKET，或改用 https:// 图片地址、asset:// 素材");
  }
  if (isRemoteUrl(imagePath)) return imagePath;

  const info = await stat(imagePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`参考图不存在：${imagePath}`);

  const body = await readFile(imagePath);
  const safeName = path.basename(imagePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${credentials.prefix || "yonge-video-gen/"}${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;
  const host = `${credentials.bucket}.cos.${credentials.region}.myqcloud.com`;
  const url = `https://${host}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const putAuth = cosAuthorization("PUT", `/${key}`, host, credentials.secretId, credentials.secretKey);
  const upload = await fetch(url, {
    method: "PUT",
    headers: { Host: host, "Content-Type": mimeTypeFor(imagePath, "image"), Authorization: putAuth },
    body,
  });
  if (!upload.ok) throw new Error(`腾讯 COS 上传失败（${upload.status}）：${(await upload.text()).slice(0, 200)}`);

  const getAuth = cosAuthorization("GET", `/${key}`, host, credentials.secretId, credentials.secretKey);
  return `${url}?${getAuth}`;
}

/** 腾讯 COS 请求签名（sha1 体系），与 infinite-canvas 开发代理里的实现一致。 */
function cosAuthorization(method: string, uri: string, host: string, secretId: string, secretKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const signTime = `${now};${now + 7200}`;
  const signKey = createHmac("sha1", secretKey).update(signTime).digest("hex");
  const formatString = `${method.toLowerCase()}\n${uri}\n\n`;
  const httpString = createHash("sha1").update(`${formatString}host=${host}\n`).digest("hex");
  const stringToSign = `sha1\n${signTime}\n${httpString}\n`;
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${signTime}&q-key-time=${signTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
}

/** 供测试与诊断使用：清掉进程内缓存。 */
export function resetArkAssetCaches(): void {
  groupCache.clear();
  credentialsPromise = null;
}
