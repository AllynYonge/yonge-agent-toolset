/**
 * OpenAI 兼容视频接口（Sora 系及各类网关）。
 *
 * 与方舟的区别：创建任务用 multipart/form-data，参考图放 input_reference[]；
 * 结果可能在任务对象里给 URL，也可能只在 /videos/{id}/content 拿二进制，两条路都要走。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { isPassthroughReference, mimeTypeFor } from "../lib/media";
import { PendingError } from "./ark";
import type { VideoRequest, VideoResult } from "../types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** OpenAI 侧只有固定档位，21:9 / 4:3 这类方舟画幅落到最近的横竖版。 */
const PORTRAIT_RATIOS = ["9:16", "2:3", "3:4"];

export const pollIntervalMs = 2500;
export const pollTimeoutMs = 10 * 60 * 1000;

export function getDefaultModel(): string {
  return process.env.OPENAI_VIDEO_MODEL || "sora-2";
}

function getBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("缺少 OPENAI_API_KEY。写入 ~/.yonge/.yonge-skills/.env 或设置环境变量");
  return key;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getApiKey()}` };
}

export function validateRequest(request: VideoRequest): void {
  if (request.videos.length || request.audios.length) {
    throw new Error("OpenAI 兼容视频接口不支持参考视频/参考音频，请改用 --provider ark");
  }
  if (request.lastFrame) throw new Error("OpenAI 兼容视频接口不支持尾帧，请改用 --provider ark");
  if (!request.prompt.trim()) throw new Error("提示词不能为空");
}

export async function createTask(request: VideoRequest): Promise<string> {
  validateRequest(request);

  const body = new FormData();
  body.append("model", request.model);
  body.append("prompt", request.prompt);
  body.append("seconds", String(request.duration === -1 ? 6 : request.duration));
  const size = sizeForRatio(request.ratio);
  if (size) body.append("size", size);
  body.append("resolution_name", request.resolution);
  body.append("preset", "normal");

  for (const image of request.images.slice(0, 7)) {
    if (isPassthroughReference(image)) {
      throw new Error(`OpenAI 兼容接口的参考图需为本地文件路径，收到：${image}`);
    }
    const bytes = await readFile(image);
    body.append("input_reference[]", new Blob([bytes], { type: mimeTypeFor(image, "image") }), path.basename(image));
  }

  const response = await fetch(`${getBaseUrl()}/videos`, { method: "POST", headers: authHeaders(), body });
  const task = unwrap(await readJson(response), response.status, "创建视频任务失败");
  if (!task.id) throw new Error("接口未返回任务 ID");
  return task.id;
}

export async function pollTask(taskId: string, _model: string): Promise<VideoResult> {
  const response = await fetch(`${getBaseUrl()}/videos/${encodeURIComponent(taskId)}`, { headers: authHeaders() });
  const task = unwrap(await readJson(response), response.status, "查询视频任务失败");

  const url = [task.video_url, task.result_url, task.url, task.content?.video_url, task.content?.url].find(
    (value): value is string => typeof value === "string" && /^https?:\/\//i.test(value),
  );
  if (url) {
    const download = await fetch(url);
    if (download.ok) return { data: new Uint8Array(await download.arrayBuffer()), url, taskId, mimeType: "video/mp4" };
    return { data: null, url, taskId, mimeType: "video/mp4" };
  }

  if (task.status === "completed" || task.status === "succeeded") {
    // 没给 URL 就走 content 端点取二进制
    const content = await fetch(`${getBaseUrl()}/videos/${encodeURIComponent(taskId)}/content`, { headers: authHeaders() });
    if (!content.ok) throw new Error(`下载视频失败（${content.status}）`);
    const buffer = new Uint8Array(await content.arrayBuffer());
    await assertNotJsonError(buffer, content.headers.get("content-type") || "");
    return { data: buffer, url: null, taskId, mimeType: "video/mp4" };
  }
  if (task.status === "failed" || task.status === "cancelled") {
    throw new Error(task.error?.message || "视频生成失败");
  }
  throw new PendingError(task.status || "queued");
}

/** 某些网关会用 200 + JSON 错误体伪装成视频流，这里把它揪出来，否则会写出一个坏 mp4。 */
async function assertNotJsonError(buffer: Uint8Array, contentType: string): Promise<void> {
  if (!contentType.includes("json")) return;
  try {
    const payload = JSON.parse(new TextDecoder().decode(buffer)) as { code?: number; msg?: string; error?: { message?: string } };
    if (payload.error?.message) throw new Error(payload.error.message);
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "下载视频失败");
  } catch (error) {
    if (error instanceof Error && error.message) throw error;
  }
}

function sizeForRatio(ratio: string): string | null {
  if (ratio === "adaptive") return null;
  return PORTRAIT_RATIOS.includes(ratio) ? "720x1280" : "1280x720";
}

type Task = {
  id?: string;
  status?: string;
  error?: { message?: string } | null;
  url?: string;
  result_url?: string;
  video_url?: string;
  content?: { video_url?: string; url?: string } | null;
};

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回非 JSON（${response.status}）：${text.slice(0, 200)}`);
  }
}

function unwrap(payload: unknown, status: number, fallback: string): Task {
  if (!payload || typeof payload !== "object") throw new Error(`${fallback}（${status}）`);
  const record = payload as Record<string, unknown> & Task;
  if ("code" in record && record.code !== undefined && record.code !== 0 && record.code !== "0") {
    throw new Error(String(record.msg || record.message || fallback));
  }
  if (status >= 400) {
    const error = record.error as { message?: string } | undefined;
    throw new Error(error?.message || String(record.message || `${fallback}（${status}）`));
  }
  if (record.data && typeof record.data === "object") return record.data as Task;
  return record;
}
