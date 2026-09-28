/** 本地素材读取、MIME 推断、可选的 ffprobe 探测。 */
import path from "node:path";
import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";

import type { MediaProbe } from "./seedance";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
};
const VIDEO_MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime" };
const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

export function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** asset://<id> 是方舟素材库引用，已授权，直接透传不必再上传。 */
export function isArkAssetUri(value: string): boolean {
  return value.startsWith("asset://");
}

export function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

/** 已经是服务端可直接取用的引用（远端 URL / asset:// / data:），无需读本地文件。 */
export function isPassthroughReference(value: string): boolean {
  return isRemoteUrl(value) || isArkAssetUri(value) || isDataUrl(value);
}

export function mimeTypeFor(filePath: string, kind: "image" | "video" | "audio"): string {
  const ext = path.extname(filePath).toLowerCase();
  if (kind === "image") return IMAGE_MIME[ext] || "image/png";
  if (kind === "video") return VIDEO_MIME[ext] || "video/mp4";
  return AUDIO_MIME[ext] || "audio/mpeg";
}

export async function toDataUrl(filePath: string, kind: "image" | "video" | "audio"): Promise<string> {
  const bytes = await readFile(filePath);
  return `data:${mimeTypeFor(filePath, kind)};base64,${bytes.toString("base64")}`;
}

/** 把混合输入（本地路径 / URL / asset://）统一成 provider 可用的字符串。本地文件转 Data URL。 */
export async function resolveReference(value: string, kind: "image" | "video" | "audio"): Promise<string> {
  if (isPassthroughReference(value)) return value;
  await assertFileExists(value);
  return toDataUrl(value, kind);
}

export async function assertFileExists(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`不是文件：${filePath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("不是文件")) throw error;
    throw new Error(`素材文件不存在：${filePath}`);
  }
}

/**
 * 探测本地媒体的尺寸/时长/体积。
 * ffprobe 缺失时只回填体积和 MIME，不报错——方舟服务端仍会做一遍校验，
 * 本地探测只是把常见错误提前暴露，不该成为硬依赖。
 */
export async function probeMedia(filePath: string, kind: "video" | "audio"): Promise<MediaProbe> {
  if (isPassthroughReference(filePath)) return {};
  const info = await stat(filePath).catch(() => null);
  const probe: MediaProbe = { bytes: info?.size, mimeType: mimeTypeFor(filePath, kind) };
  const ffprobe = await runFfprobe(filePath);
  if (!ffprobe) return probe;
  const stream = ffprobe.streams?.find((item) => item.codec_type === (kind === "video" ? "video" : "audio"));
  const durationSeconds = Number(ffprobe.format?.duration ?? stream?.duration ?? 0);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) probe.durationMs = Math.round(durationSeconds * 1000);
  if (kind === "video" && stream?.width && stream?.height) {
    probe.width = stream.width;
    probe.height = stream.height;
  }
  return probe;
}

type FfprobeOutput = {
  streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  format?: { duration?: string };
};

async function runFfprobe(filePath: string): Promise<FfprobeOutput | null> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0 || !output.trim()) return null;
    return JSON.parse(output) as FfprobeOutput;
  } catch {
    return null;
  }
}

export function ensureVideoExtension(outputPath: string): string {
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === ".mp4" || ext === ".mov") return outputPath;
  return `${outputPath}.mp4`;
}
