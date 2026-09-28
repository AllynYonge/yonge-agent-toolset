/** 供应商标识。ark = 火山方舟 Seedance（含 asset:// 素材流程），openai = OpenAI 兼容 /videos 任务接口。 */
export type Provider = "ark" | "openai";

export type Resolution = "480p" | "720p" | "1080p";
/** -1 = 由模型自适应时长（方舟 duration=-1）。 */
export type Duration = -1 | 4 | 5 | 6 | 8 | 10 | 12 | 15;
export type Ratio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" | "adaptive";

export type CliArgs = {
  prompt: string | null;
  promptFiles: string[];
  videoPath: string | null;
  provider: Provider | null;
  model: string | null;
  ratio: string | null;
  resolution: string | null;
  duration: string | null;
  referenceImages: string[];
  referenceVideos: string[];
  referenceAudios: string[];
  /** 首帧图（等价于 ref 的第一张，方舟按 reference_image 处理）。 */
  firstFrame: string | null;
  lastFrame: string | null;
  generateAudio: boolean | null;
  watermark: boolean | null;
  seed: number | null;
  cameraFixed: boolean | null;
  batchFile: string | null;
  jobs: number | null;
  /** 只创建任务、打印 taskId 后退出，不轮询。 */
  noWait: boolean;
  /** 轮询已存在的任务 ID。 */
  taskId: string | null;
  json: boolean;
  help: boolean;
};

export type BatchTaskInput = {
  id?: string;
  prompt?: string | null;
  promptFiles?: string[];
  video?: string;
  provider?: Provider | null;
  model?: string | null;
  ratio?: string | null;
  resolution?: string | null;
  duration?: string | number | null;
  ref?: string[];
  refVideo?: string[];
  refAudio?: string[];
  firstFrame?: string | null;
  lastFrame?: string | null;
  generateAudio?: boolean | null;
  watermark?: boolean | null;
  seed?: number | null;
  cameraFixed?: boolean | null;
};

export type BatchFile = BatchTaskInput[] | { tasks: BatchTaskInput[]; jobs?: number | null };

export type ExtendConfig = {
  version: number;
  default_provider: Provider | null;
  default_ratio: string | null;
  default_resolution: string | null;
  default_duration: number | null;
  default_generate_audio: boolean | null;
  default_watermark: boolean | null;
  default_model: {
    ark: string | null;
    openai: string | null;
  };
  batch?: {
    max_workers?: number | null;
    provider_limits?: Partial<Record<Provider, { concurrency?: number | null; start_interval_ms?: number | null }>>;
  };
};

/** 归一化后的生成参数，供 provider 直接使用。 */
export type VideoRequest = {
  prompt: string;
  model: string;
  ratio: Ratio;
  resolution: Resolution;
  duration: Duration;
  generateAudio: boolean;
  watermark: boolean;
  seed: number | null;
  cameraFixed: boolean | null;
  images: string[];
  videos: string[];
  audios: string[];
  lastFrame: string | null;
};

export type VideoResult = {
  /** 已下载的视频字节；provider 未能下载时为 null，此时 url 必有值。 */
  data: Uint8Array | null;
  url: string | null;
  taskId: string;
  mimeType: string;
};

export type ProviderModule = {
  getDefaultModel: () => string;
  createTask: (request: VideoRequest) => Promise<string>;
  pollTask: (taskId: string, model: string) => Promise<VideoResult>;
  validateRequest?: (request: VideoRequest) => void;
  /** 轮询间隔，方舟官方建议 5s 起。 */
  pollIntervalMs: number;
  pollTimeoutMs: number;
};
