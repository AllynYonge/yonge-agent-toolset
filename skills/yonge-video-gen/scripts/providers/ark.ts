/**
 * 火山方舟 Seedance 视频生成。
 *
 * 接口形态：POST /contents/generations/tasks 创建任务 → GET /contents/generations/tasks/{id} 轮询。
 * 与图片接口不同，方舟视频是纯异步任务制，没有同步返回；参数不放在顶层字段而是拆成
 * content 数组（text / image_url / video_url / audio_url），每项带 role 标明用途。
 */
import { resolveArkImageAsset } from "../lib/ark-assets";
import { isArkAssetUri, probeMedia, resolveReference } from "../lib/media";
import {
  assertReferenceCounts,
  audioReferenceError,
  buildPromptText,
  REFERENCE_LIMITS,
  videoReferenceError,
} from "../lib/seedance";
import type { VideoRequest, VideoResult } from "../types";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

export const pollIntervalMs = 5000;
export const pollTimeoutMs = 10 * 60 * 1000;

export function getDefaultModel(): string {
  return process.env.ARK_VIDEO_MODEL || "doubao-seedance-1-0-pro-250528";
}

function getBaseUrl(): string {
  return (process.env.ARK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getApiKey(): string {
  const key = process.env.ARK_API_KEY?.trim();
  if (!key) {
    throw new Error("缺少 ARK_API_KEY。到 https://console.volcengine.com/ark 获取，然后写入 ~/.yonge/.yonge-skills/.env 或环境变量");
  }
  return key;
}

function headers(contentType?: string): Record<string, string> {
  return { Authorization: `Bearer ${getApiKey()}`, ...(contentType ? { "Content-Type": contentType } : {}) };
}

export function validateRequest(request: VideoRequest): void {
  assertReferenceCounts(request);
  if (!request.prompt.trim() && !request.images.length && !request.videos.length) {
    throw new Error("提示词为空且没有任何视觉参考素材，无法生成");
  }
  if (request.lastFrame && !request.images.length) {
    throw new Error("指定尾帧时必须同时提供首帧图（--first-frame 或 --ref）");
  }
}

type ArkTask = {
  id?: string;
  status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
  error?: { code?: string; message?: string } | null;
  content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
  url?: string;
  result_url?: string;
  video_url?: string;
};

type ArkEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };

export async function createTask(request: VideoRequest): Promise<string> {
  validateRequest(request);
  await assertReferenceMedia(request);

  const content = await buildContent(request);
  const payload: Record<string, unknown> = {
    model: request.model,
    content,
    ratio: request.ratio,
    resolution: request.resolution,
    duration: request.duration,
    generate_audio: request.generateAudio,
    watermark: request.watermark,
  };
  // seed / camera_fixed 只在显式指定时下发，避免覆盖模型默认策略
  if (request.seed !== null) payload.seed = request.seed;
  if (request.cameraFixed !== null) payload.camera_fixed = request.cameraFixed;

  const response = await fetch(`${getBaseUrl()}/contents/generations/tasks`, {
    method: "POST",
    headers: headers("application/json"),
    body: JSON.stringify(payload),
  });
  const task = unwrap<ArkTask>(await readJson(response), response.status, "创建方舟视频任务失败");
  if (!task.id) throw new Error("方舟未返回任务 ID");
  return task.id;
}

export async function pollTask(taskId: string, _model: string): Promise<VideoResult> {
  const url = `${getBaseUrl()}/contents/generations/tasks/${encodeURIComponent(taskId)}`;
  const response = await fetch(url, { headers: headers() });
  const task = unwrap<ArkTask>(await readJson(response), response.status, "查询方舟视频任务失败");

  const videoUrl = resultUrl(task);
  if (videoUrl) return downloadResult(videoUrl, taskId);

  if (task.status === "succeeded" || task.status === "completed") {
    throw new Error("方舟任务已完成但未返回视频地址");
  }
  if (task.status === "failed" || task.status === "cancelled") {
    throw new Error(friendlyError(task.error?.message) || "方舟视频生成失败");
  }
  if (task.status === "expired") throw new Error("方舟视频任务已过期");

  // 仍在排队/生成中，用 PENDING 让 main 继续轮询
  throw new PendingError(task.status || "queued");
}

/** 用异常表示"未完成"，让 provider 接口保持单一返回类型，main 只需 catch 判类型。 */
export class PendingError extends Error {
  constructor(public readonly state: string) {
    super(`pending:${state}`);
    this.name = "PendingError";
  }
}

async function buildContent(request: VideoRequest): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = [];
  const text = buildPromptText(request);
  if (text) content.push({ type: "text", text });

  for (let index = 0; index < request.images.slice(0, REFERENCE_LIMITS.images).length; index += 1) {
    const image = request.images[index]!;
    const url = await resolveImageForArk(image);
    // 首帧语义：单张参考图时方舟按首帧处理；多张时是 reference_image 组
    content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  }
  if (request.lastFrame) {
    content.push({ type: "image_url", image_url: { url: await resolveImageForArk(request.lastFrame) }, role: "last_frame" });
  }
  for (const video of request.videos.slice(0, REFERENCE_LIMITS.videos)) {
    content.push({ type: "video_url", video_url: { url: await resolveReference(video, "video") }, role: "reference_video" });
  }
  for (const audio of request.audios.slice(0, REFERENCE_LIMITS.audios)) {
    content.push({ type: "audio_url", audio_url: { url: await resolveReference(audio, "audio") }, role: "reference_audio" });
  }
  return content;
}

/**
 * 参考图统一走素材库。
 * 直接传 Data URL 在含真人人脸时会被方舟拒（"real person" 类错误），
 * 而事先无法可靠判断一张图里有没有真人脸，所以默认全部转 asset://。
 * 设 YONGE_VIDEO_GEN_ARK_DIRECT_IMAGE=1 可跳过（仅在确认无真人且想省一次上传时用）。
 */
async function resolveImageForArk(image: string): Promise<string> {
  if (isArkAssetUri(image)) return image;
  if (process.env.YONGE_VIDEO_GEN_ARK_DIRECT_IMAGE === "1") return resolveReference(image, "image");
  return resolveArkImageAsset(image);
}

async function assertReferenceMedia(request: VideoRequest): Promise<void> {
  const videoProbes = await Promise.all(request.videos.map((file) => probeMedia(file, "video")));
  const videoError = videoReferenceError(videoProbes);
  if (videoError) throw new Error(videoError);

  const audioProbes = await Promise.all(request.audios.map((file) => probeMedia(file, "audio")));
  const audioError = audioReferenceError(audioProbes);
  if (audioError) throw new Error(audioError);
}

async function downloadResult(url: string, taskId: string): Promise<VideoResult> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { data: buffer, url, taskId, mimeType: "video/mp4" };
  } catch {
    // 下载失败不算生成失败：URL 有效期内用户仍可自取
    return { data: null, url, taskId, mimeType: "video/mp4" };
  }
}

function resultUrl(task: ArkTask): string | null {
  const candidates = [task.video_url, task.result_url, task.url, task.content?.video_url, task.content?.url];
  return candidates.find((value): value is string => typeof value === "string" && /^https?:\/\//i.test(value)) ?? null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`方舟返回非 JSON（${response.status}）：${text.slice(0, 200)}`);
  }
}

/** 方舟有两种响应形态：裸对象，或 {code,data,msg} 信封。统一拆包并把错误抬成异常。 */
function unwrap<T>(payload: unknown, status: number, fallback: string): T {
  if (!payload || typeof payload !== "object") throw new Error(`${fallback}（${status}）`);
  const record = payload as Record<string, unknown>;

  if ("code" in record && record.code !== undefined && record.code !== 0 && record.code !== "0") {
    throw new Error(friendlyError(readMessage(record)) || `${fallback}（${status}）`);
  }
  if ("error" in record && record.error && typeof record.error === "object") {
    const message = readMessage(record.error as Record<string, unknown>);
    if (message) throw new Error(friendlyError(message));
  }
  if (status >= 400) {
    throw new Error(friendlyError(readMessage(record)) || statusMessage(status, fallback));
  }
  if ("data" in record && record.data && typeof record.data === "object") return record.data as T;
  return record as T;
}

function readMessage(record: Record<string, unknown>): string {
  for (const key of ["message", "msg", "Message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nested = record.error;
  if (nested && typeof nested === "object") return readMessage(nested as Record<string, unknown>);
  if (typeof nested === "string") return nested;
  return "";
}

/** 把方舟的真人脸拒绝改写成可操作的提示——原文只说不支持，不说该怎么办。 */
function friendlyError(message: string | undefined): string {
  if (!message) return "";
  if (/real person|real face|真人|人脸/i.test(message)) {
    return `方舟不接受直接上传含真人人脸的参考图。请使用方舟素材库/虚拟人像库的 asset:// 授权素材（本技能默认会自动转 asset://，若已设 YONGE_VIDEO_GEN_ARK_DIRECT_IMAGE=1 请去掉）。原始错误：${message}`;
  }
  return message;
}

function statusMessage(status: number, fallback: string): string {
  if (status === 401 || status === 403) return "方舟鉴权失败，请检查 ARK_API_KEY";
  if (status === 429) return "方舟请求过于频繁（429），请降低并发或稍后重试";
  return `${fallback}（${status}）`;
}
