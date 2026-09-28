/**
 * 方舟 Seedance 参数归一化与参考素材校验。
 *
 * 这套规则是从 infinite-canvas 的 web/src/lib/seedance-video.ts 移植过来的，
 * 数值不要凭感觉改：它们对应火山方舟官方文档的硬性限制，越界会在创建任务时被服务端拒绝，
 * 而服务端错误信息通常只说 InvalidParameter，排查成本远高于本地先拦一次。
 */
import type { Duration, Ratio, Resolution, VideoRequest } from "../types";

export const REFERENCE_LIMITS = {
  images: 9,
  videos: 3,
  audios: 3,
  imageMaxBytes: 30 * 1024 * 1024,
  videoMaxBytes: 200 * 1024 * 1024,
  audioMaxBytes: 15 * 1024 * 1024,
  /** 单条参考视频/音频时长区间，以及所有参考视频（音频）时长之和的上限。 */
  clipMinMs: 2000,
  clipMaxMs: 15000,
  clipTotalMaxMs: 15000,
} as const;

export const RESOLUTIONS: Resolution[] = ["480p", "720p", "1080p"];
export const RATIOS: Ratio[] = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"];
export const DURATIONS: Duration[] = [-1, 4, 5, 6, 8, 10, 12, 15];

export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
export const VIDEO_EXTENSIONS = [".mp4", ".mov"];

/** 各分辨率 × 画幅的实际像素，仅用于日志展示，让用户知道最终出片尺寸。 */
const PIXELS: Record<Resolution, Record<Exclude<Ratio, "adaptive">, string>> = {
  "480p": { "16:9": "864x496", "4:3": "752x560", "1:1": "640x640", "3:4": "560x752", "9:16": "496x864", "21:9": "992x432" },
  "720p": { "16:9": "1280x720", "4:3": "1112x834", "1:1": "960x960", "3:4": "834x1112", "9:16": "720x1280", "21:9": "1470x630" },
  "1080p": { "16:9": "1920x1080", "4:3": "1664x1248", "1:1": "1440x1440", "3:4": "1248x1664", "9:16": "1080x1920", "21:9": "2206x946" },
};

export function normalizeResolution(value: string | null | undefined): Resolution {
  const token = normalizeResolutionToken(value);
  return (RESOLUTIONS as string[]).includes(token) ? (token as Resolution) : "720p";
}

export function normalizeResolutionToken(value: string | null | undefined): string {
  if (value === "low") return "480p";
  if (!value || value === "auto" || value === "high" || value === "medium") return "720p";
  const resolution = String(value).replace(/p$/i, "") || "720";
  return `${resolution}p`;
}

export function normalizeDuration(value: string | number | null | undefined): Duration {
  if (value === null || value === undefined || String(value).trim() === "") return 5;
  if (String(value).trim() === "-1") return -1;
  const seconds = Math.floor(Number(value) || 5);
  const clamped = Math.max(4, Math.min(15, seconds));
  return clamped as Duration;
}

export function normalizeRatio(value: string | null | undefined): Ratio {
  if (!value || value === "auto" || value === "adaptive") return "adaptive";
  if ((RATIOS as string[]).includes(value)) return value as Ratio;
  const match = value.match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) return "adaptive";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "adaptive";
  const ratio = width / height;
  // 落到最近的官方画幅，而不是直接透传 WxH：方舟 video 接口只认枚举画幅。
  const options: Array<[Ratio, number]> = [
    ["16:9", 16 / 9],
    ["4:3", 4 / 3],
    ["1:1", 1],
    ["3:4", 3 / 4],
    ["9:16", 9 / 16],
    ["21:9", 21 / 9],
  ];
  let best: [Ratio, number] = ["16:9", 16 / 9];
  for (const option of options) {
    if (Math.abs(option[1] - ratio) < Math.abs(best[1] - ratio)) best = option;
  }
  return best[0];
}

export function pixelLabel(resolution: Resolution, ratio: Ratio): string {
  if (ratio === "adaptive") return "自适应（由参考图/首帧决定）";
  return PIXELS[resolution][ratio] || "";
}

export function referenceLabel(kind: "image" | "video" | "audio", index: number): string {
  const zh = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
  return `${zh}${index + 1}`;
}

/**
 * 在提示词前面挂上参考素材编号表。
 * 多素材时模型无法凭空知道「图片2」指哪张，显式编号后提示词里就能写"图片1里的人走进图片2的房间"。
 */
export function buildPromptText(request: Pick<VideoRequest, "prompt" | "images" | "videos" | "audios">): string {
  const labels = [
    ...request.images.map((_, index) => referenceLabel("image", index)),
    ...request.videos.map((_, index) => referenceLabel("video", index)),
    ...request.audios.map((_, index) => referenceLabel("audio", index)),
  ];
  const text = request.prompt.trim();
  if (!labels.length) return text;
  return `参考资产编号：${labels.join("、")}。请按这些编号理解提示词中的图片、视频和音频引用。\n\n${text}`;
}

export type MediaProbe = {
  mimeType?: string;
  bytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
};

/** 返回第一条错误信息；空字符串表示通过。逐条返回而非收集全部，是为了让用户一次只修一个明确问题。 */
export function videoReferenceError(probes: MediaProbe[]): string {
  let totalDurationMs = 0;
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index]!;
    const label = referenceLabel("video", index);
    if (probe.mimeType && !VIDEO_MIME_TYPES.includes(probe.mimeType)) return `${label} 仅支持 mp4/mov 格式`;
    if (probe.bytes && probe.bytes > REFERENCE_LIMITS.videoMaxBytes) return `${label} 超过 200MB`;
    if (probe.durationMs) {
      if (probe.durationMs < REFERENCE_LIMITS.clipMinMs || probe.durationMs > REFERENCE_LIMITS.clipMaxMs) {
        return `${label} 时长需在 2-15 秒之间`;
      }
      totalDurationMs += probe.durationMs;
    }
    if (probe.width && probe.height) {
      if (probe.width < 300 || probe.width > 6000 || probe.height < 300 || probe.height > 6000) {
        return `${label} 宽高需在 300-6000 之间`;
      }
      const ratio = probe.width / probe.height;
      if (ratio < 0.4 || ratio > 2.5) return `${label} 宽高比需在 0.4-2.5 之间`;
      const pixels = probe.width * probe.height;
      if (pixels < 640 * 640 || pixels > 3326 * 2494) return `${label} 总像素需在 409600-8295044 之间`;
    }
  }
  if (totalDurationMs > REFERENCE_LIMITS.clipTotalMaxMs) return "参考视频总时长不得超过 15 秒";
  return "";
}

export function audioReferenceError(probes: MediaProbe[]): string {
  let totalDurationMs = 0;
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index]!;
    const label = referenceLabel("audio", index);
    if (probe.bytes && probe.bytes > REFERENCE_LIMITS.audioMaxBytes) return `${label} 超过 15MB`;
    if (probe.durationMs) {
      if (probe.durationMs < REFERENCE_LIMITS.clipMinMs || probe.durationMs > REFERENCE_LIMITS.clipMaxMs) {
        return `${label} 时长需在 2-15 秒之间`;
      }
      totalDurationMs += probe.durationMs;
    }
  }
  if (totalDurationMs > REFERENCE_LIMITS.clipTotalMaxMs) return "参考音频总时长不得超过 15 秒";
  return "";
}

/** 参考素材数量与组合关系校验。音频不能单独存在——方舟要求至少有一路视觉素材来承载音频。 */
export function assertReferenceCounts(request: Pick<VideoRequest, "images" | "videos" | "audios">): void {
  if (request.images.length > REFERENCE_LIMITS.images) {
    throw new Error(`参考图最多 ${REFERENCE_LIMITS.images} 张，当前 ${request.images.length} 张`);
  }
  if (request.videos.length > REFERENCE_LIMITS.videos) {
    throw new Error(`参考视频最多 ${REFERENCE_LIMITS.videos} 条，当前 ${request.videos.length} 条`);
  }
  if (request.audios.length > REFERENCE_LIMITS.audios) {
    throw new Error(`参考音频最多 ${REFERENCE_LIMITS.audios} 条，当前 ${request.audios.length} 条`);
  }
  if (request.audios.length && !request.images.length && !request.videos.length) {
    throw new Error("参考音频需要至少搭配一张参考图或一条参考视频");
  }
}
