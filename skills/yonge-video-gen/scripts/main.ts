#!/usr/bin/env bun
/**
 * yonge-video-gen 主入口。
 *
 * 职责：解析参数 → 加载配置/凭证 → 归一化生成参数 → 交给 provider 建任务并轮询 → 落盘。
 * 视频生成是分钟级异步任务，所以这里的核心不是并发吞吐，而是"任务 ID 不能丢"：
 * 每个任务创建成功后立刻打印 taskId，中断也能用 --task-id 续查。
 */
import path from "node:path";
import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { ensureVideoExtension } from "./lib/media";
import { normalizeDuration, normalizeRatio, normalizeResolution, pixelLabel } from "./lib/seedance";
import { ConfigError, getConfigValue, loadDotEnv, loadSkillConfig, type ConfigMap } from "./lib/skill-config";
import { PendingError } from "./providers/ark";
import type {
  BatchFile,
  BatchTaskInput,
  CliArgs,
  ExtendConfig,
  Provider,
  ProviderModule,
  VideoRequest,
  VideoResult,
} from "./types";

const MAX_ATTEMPTS = 2;
const DEFAULT_MAX_WORKERS = 3;
const DEFAULT_RATE_LIMITS: Record<Provider, { concurrency: number; startIntervalMs: number }> = {
  // 视频任务单价高、耗时长，默认并发保守：一次打爆配额比慢几分钟更糟
  ark: { concurrency: 2, startIntervalMs: 2000 },
  openai: { concurrency: 2, startIntervalMs: 2000 },
};

type PreparedTask = {
  id: string;
  request: VideoRequest;
  provider: Provider;
  outputPath: string;
  module: ProviderModule;
};

type TaskResult = {
  id: string;
  provider: Provider;
  model: string;
  outputPath: string | null;
  taskId: string | null;
  url: string | null;
  success: boolean;
  attempts: number;
  error: string | null;
};

function printUsage(): void {
  console.log(`用法:
  bun scripts/main.ts --prompt "镜头缓慢推近" --video out.mp4
  bun scripts/main.ts --promptfiles shot.md --video out.mp4 --ref first.png --ratio 16:9
  bun scripts/main.ts --batchfile batch.json --jobs 2
  bun scripts/main.ts --task-id cgt-xxx --video out.mp4        # 续查已创建的任务

参数:
  -p, --prompt <text>        提示词
  --promptfiles <files...>   从文件读取提示词（多文件拼接）
  --video <path>             输出视频路径（单任务模式必填）
  --batchfile <path>         批量任务 JSON
  --jobs <count>             批量并发数（默认 2，上限见 EXTEND.md）
  --provider ark|openai      指定供应商（默认按可用凭证自动选择，ark 优先）
  -m, --model <id>           模型 ID
  --ratio <r>                画幅 16:9|9:16|1:1|4:3|3:4|21:9|adaptive，也接受 WxH（就近映射）
  --resolution <r>           分辨率 480p|720p|1080p（默认 720p）
  --duration <n>             时长秒 4|5|6|8|10|12|15，或 -1 由模型自适应（默认 5）
  --ref <files...>           参考图/首帧，本地路径、https:// 或 asset://（方舟最多 9 张）
  --first-frame <file>       首帧图（等价于单张 --ref）
  --last-frame <file>        尾帧图（仅方舟，需同时有首帧）
  --ref-video <files...>     参考视频，mp4/mov，2-15 秒（仅方舟，最多 3 条）
  --ref-audio <files...>     参考音频，2-15 秒（仅方舟，最多 3 条，需搭配视觉素材）
  --audio / --no-audio       是否生成音频（默认生成）
  --watermark                打水印（默认不打）
  --seed <n>                 随机种子
  --camera-fixed             固定镜头
  --no-wait                  只创建任务并打印 taskId，不轮询
  --task-id <id>             轮询已有任务（配合 --video 落盘）
  --json                     JSON 输出
  -h, --help                 显示帮助

批量文件格式:
  { "jobs": 2, "tasks": [ { "id": "s01", "promptFiles": ["prompts/s01.md"], "video": "out/s01.mp4", "ref": ["kf/s01.png"], "ratio": "16:9" } ] }

配置与凭证加载优先级:
  CLI 参数 > EXTEND.md > 环境变量 > <cwd>/.yonge/.yonge-skills/.env > ~/.yonge/.yonge-skills/.env > 内置默认值
  偏好写在 .yonge/.yonge-skills/yonge-video-gen/EXTEND.md（项目级优先，命中第一个就停）
  密钥只放 .env，不写进 EXTEND.md。方舟 AK/SK 与腾讯 COS 凭证同放（ARK_ACCESS_KEY/ARK_SECRET_KEY/TENCENT_COS_*）

环境变量:
  ARK_API_KEY            方舟 API Key（视频生成必需）
  ARK_VIDEO_MODEL        方舟默认模型
  ARK_BASE_URL           方舟接口地址（默认 https://ark.cn-beijing.volces.com/api/v3）
  ARK_ACCESS_KEY/ARK_SECRET_KEY  方舟 AK/SK（asset:// 素材流程需要）
  TENCENT_COS_SECRET_ID/SECRET_KEY/REGION/BUCKET/PREFIX/DOMAIN  腾讯 COS（asset:// 素材流程需要）
  OPENAI_API_KEY         OpenAI 兼容接口 Key
  OPENAI_VIDEO_MODEL     OpenAI 默认模型
  YONGE_VIDEO_GEN_MAX_WORKERS   批量并发上限
  YONGE_VIDEO_GEN_ARK_DIRECT_IMAGE=1  跳过 asset:// 转换直传参考图（确认无真人脸时用）`);
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    prompt: null,
    promptFiles: [],
    videoPath: null,
    provider: null,
    model: null,
    ratio: null,
    resolution: null,
    duration: null,
    referenceImages: [],
    referenceVideos: [],
    referenceAudios: [],
    firstFrame: null,
    lastFrame: null,
    generateAudio: null,
    watermark: null,
    seed: null,
    cameraFixed: null,
    batchFile: null,
    jobs: null,
    noWait: false,
    taskId: null,
    json: false,
    help: false,
  };
  const positional: string[] = [];

  const takeMany = (i: number): { items: string[]; next: number } => {
    const items: string[] = [];
    let j = i + 1;
    while (j < argv.length && !argv[j]!.startsWith("-")) {
      items.push(argv[j]!);
      j += 1;
    }
    return { items, next: j - 1 };
  };
  const takeOne = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (!value) throw new Error(`${flag} 缺少参数值`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "--no-wait") { out.noWait = true; continue; }
    if (a === "--audio") { out.generateAudio = true; continue; }
    if (a === "--no-audio") { out.generateAudio = false; continue; }
    if (a === "--watermark") { out.watermark = true; continue; }
    if (a === "--no-watermark") { out.watermark = false; continue; }
    if (a === "--camera-fixed") { out.cameraFixed = true; continue; }
    if (a === "--no-camera-fixed") { out.cameraFixed = false; continue; }
    if (a === "-p" || a === "--prompt") { out.prompt = takeOne(i, a); i += 1; continue; }
    if (a === "--video" || a === "--output" || a === "-o") { out.videoPath = takeOne(i, a); i += 1; continue; }
    if (a === "--batchfile") { out.batchFile = takeOne(i, a); i += 1; continue; }
    if (a === "-m" || a === "--model") { out.model = takeOne(i, a); i += 1; continue; }
    if (a === "--ratio" || a === "--ar") { out.ratio = takeOne(i, a); i += 1; continue; }
    if (a === "--resolution") { out.resolution = takeOne(i, a); i += 1; continue; }
    if (a === "--duration") { out.duration = takeOne(i, a); i += 1; continue; }
    if (a === "--first-frame") { out.firstFrame = takeOne(i, a); i += 1; continue; }
    if (a === "--last-frame") { out.lastFrame = takeOne(i, a); i += 1; continue; }
    if (a === "--task-id") { out.taskId = takeOne(i, a); i += 1; continue; }
    if (a === "--provider") {
      const value = takeOne(i, a);
      if (value !== "ark" && value !== "openai") throw new Error(`不支持的供应商：${value}（可选 ark|openai）`);
      out.provider = value;
      i += 1;
      continue;
    }
    if (a === "--jobs") {
      const value = parseInt(takeOne(i, a), 10);
      if (!Number.isFinite(value) || value < 1) throw new Error("--jobs 需为正整数");
      out.jobs = value;
      i += 1;
      continue;
    }
    if (a === "--seed") {
      const value = parseInt(takeOne(i, a), 10);
      if (!Number.isFinite(value)) throw new Error("--seed 需为整数");
      out.seed = value;
      i += 1;
      continue;
    }
    if (a === "--promptfiles") {
      const { items, next } = takeMany(i);
      if (!items.length) throw new Error("--promptfiles 缺少文件");
      out.promptFiles.push(...items);
      i = next;
      continue;
    }
    if (a === "--ref" || a === "--reference") {
      const { items, next } = takeMany(i);
      if (!items.length) throw new Error(`${a} 缺少文件`);
      out.referenceImages.push(...items);
      i = next;
      continue;
    }
    if (a === "--ref-video") {
      const { items, next } = takeMany(i);
      if (!items.length) throw new Error("--ref-video 缺少文件");
      out.referenceVideos.push(...items);
      i = next;
      continue;
    }
    if (a === "--ref-audio") {
      const { items, next } = takeMany(i);
      if (!items.length) throw new Error("--ref-audio 缺少文件");
      out.referenceAudios.push(...items);
      i = next;
      continue;
    }
    if (a.startsWith("-")) throw new Error(`未知参数：${a}`);
    positional.push(a);
  }

  if (!out.prompt && !out.promptFiles.length && positional.length) out.prompt = positional.join(" ");
  return out;
}

const SKILL_NAME = "yonge-video-gen";
const PROVIDERS: Provider[] = ["ark", "openai"];
const ALLOWED_KEYS = [
  "version",
  "default_provider",
  "default_ratio",
  "default_resolution",
  "default_duration",
  "default_generate_audio",
  "default_watermark",
  "default_model.ark",
  "default_model.openai",
  "batch.max_workers",
];

function optionalString(config: ConfigMap, key: string): string | null {
  const value = getConfigValue(config, key);
  if (value === undefined || value === null) return null;
  if (typeof value === "object") throw new ConfigError(`${key} 应为单个值，不能是映射`);
  return String(value);
}

function optionalNumber(config: ConfigMap, key: string): number | null {
  const value = getConfigValue(config, key);
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw new ConfigError(`${key} 应为数字，当前为 ${JSON.stringify(value)}`);
  return value;
}

function optionalBoolean(config: ConfigMap, key: string): boolean | null {
  const value = getConfigValue(config, key);
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new ConfigError(`${key} 应为 true 或 false，当前为 ${JSON.stringify(value)}`);
  return value;
}

/** 把通用解析结果转成本技能的类型。值类型不对时报错，不静默丢弃。 */
export function toExtendConfig(config: ConfigMap): Partial<ExtendConfig> {
  const provider = optionalString(config, "default_provider");
  if (provider !== null && !PROVIDERS.includes(provider as Provider)) {
    throw new ConfigError(`default_provider 只能是 ${PROVIDERS.join(" 或 ")}，当前为 ${provider}`);
  }
  const result: Partial<ExtendConfig> = {
    version: optionalNumber(config, "version") ?? 1,
    default_provider: provider as Provider | null,
    default_ratio: optionalString(config, "default_ratio"),
    default_resolution: optionalString(config, "default_resolution"),
    default_duration: optionalNumber(config, "default_duration"),
    default_generate_audio: optionalBoolean(config, "default_generate_audio"),
    default_watermark: optionalBoolean(config, "default_watermark"),
    default_model: {
      ark: optionalString(config, "default_model.ark"),
      openai: optionalString(config, "default_model.openai"),
    },
  };
  const maxWorkers = optionalNumber(config, "batch.max_workers");
  if (maxWorkers !== null) result.batch = { max_workers: maxWorkers };
  return result;
}

/** 读取 .env 与 EXTEND.md。路径、优先级与写法限制由 lib/skill-config.ts 统一实现。 */
export function loadConfig(options: { cwd?: string; home?: string } = {}): Partial<ExtendConfig> {
  loadDotEnv(options);
  const loaded = loadSkillConfig({ skill: SKILL_NAME, allowedKeys: ALLOWED_KEYS, ...options });
  for (const warning of loaded.warnings) console.error(`警告：${warning}`);
  if (!loaded.source) return {};
  try {
    return toExtendConfig(loaded.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${loaded.source.path}：${message}`);
  }
}

export function detectProvider(args: CliArgs, config: Partial<ExtendConfig>): Provider {
  if (args.provider) return args.provider;
  // 用到参考视频/音频/尾帧就只能是方舟，无需再看凭证
  if (args.referenceVideos.length || args.referenceAudios.length || args.lastFrame) return "ark";
  if (config.default_provider) return config.default_provider;
  const hasArk = Boolean(process.env.ARK_API_KEY?.trim());
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (hasArk) return "ark";
  if (hasOpenAI) return "openai";
  throw new Error("未找到可用凭证。请配置 ARK_API_KEY（火山方舟）或 OPENAI_API_KEY，写入 ~/.yonge/.yonge-skills/.env 即可（密钥不要写进 EXTEND.md）");
}

async function loadProviderModule(provider: Provider): Promise<ProviderModule> {
  const loaded = provider === "openai" ? await import("./providers/openai") : await import("./providers/ark");
  return loaded as unknown as ProviderModule;
}

async function loadPrompt(args: CliArgs): Promise<string> {
  if (args.prompt) return args.prompt;
  if (!args.promptFiles.length) return "";
  const parts = await Promise.all(args.promptFiles.map((file) => readFile(file, "utf8")));
  return parts.join("\n\n").trim();
}

function resolveModel(provider: Provider, args: CliArgs, config: Partial<ExtendConfig>, module: ProviderModule): string {
  return args.model || config.default_model?.[provider] || module.getDefaultModel();
}

function buildRequest(prompt: string, model: string, args: CliArgs, config: Partial<ExtendConfig>): VideoRequest {
  const images = [...(args.firstFrame ? [args.firstFrame] : []), ...args.referenceImages];
  return {
    prompt,
    model,
    ratio: normalizeRatio(args.ratio ?? config.default_ratio),
    resolution: normalizeResolution(args.resolution ?? config.default_resolution),
    duration: normalizeDuration(args.duration ?? config.default_duration),
    generateAudio: args.generateAudio ?? config.default_generate_audio ?? true,
    watermark: args.watermark ?? config.default_watermark ?? false,
    seed: args.seed,
    cameraFixed: args.cameraFixed,
    images,
    videos: args.referenceVideos,
    audios: args.referenceAudios,
    lastFrame: args.lastFrame,
  };
}

async function prepareSingleTask(args: CliArgs, config: Partial<ExtendConfig>): Promise<PreparedTask> {
  const prompt = await loadPrompt(args);
  if (!prompt && !args.referenceImages.length && !args.firstFrame) throw new Error("需要提示词（--prompt / --promptfiles）或参考图");
  if (!args.videoPath) throw new Error("--video 是必填参数");

  const provider = detectProvider(args, config);
  const module = await loadProviderModule(provider);
  const model = resolveModel(provider, args, config, module);
  const request = buildRequest(prompt, model, args, config);
  module.validateRequest?.(request);

  return { id: "single", request, provider, outputPath: ensureVideoExtension(args.videoPath), module };
}

export async function loadBatchTasks(batchFilePath: string): Promise<{ tasks: BatchTaskInput[]; jobs: number | null; batchDir: string }> {
  const resolved = path.resolve(batchFilePath);
  const parsed = JSON.parse((await readFile(resolved, "utf8")).replace(/^\uFEFF/, "")) as BatchFile;
  const batchDir = path.dirname(resolved);
  if (Array.isArray(parsed)) return { tasks: parsed, jobs: null, batchDir };
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.tasks)) {
    const jobs = typeof parsed.jobs === "number" && parsed.jobs > 0 ? Math.floor(parsed.jobs) : null;
    return { tasks: parsed.tasks, jobs, batchDir };
  }
  throw new Error("批量文件格式错误：需为任务数组，或含 tasks 数组的对象");
}

function resolveBatchPath(batchDir: string, filePath: string): string {
  // https:// 与 asset:// 是引用而非路径，不能拼目录
  if (/^(https?:\/\/|asset:\/\/|data:)/i.test(filePath)) return filePath;
  return path.isAbsolute(filePath) ? filePath : path.resolve(batchDir, filePath);
}

export function createTaskArgs(base: CliArgs, task: BatchTaskInput, batchDir: string): CliArgs {
  const mapPaths = (files: string[] | undefined) => (files ?? []).map((file) => resolveBatchPath(batchDir, file));
  return {
    ...base,
    prompt: task.prompt ?? null,
    promptFiles: mapPaths(task.promptFiles),
    videoPath: task.video ? resolveBatchPath(batchDir, task.video) : null,
    provider: task.provider ?? base.provider ?? null,
    model: task.model ?? base.model ?? null,
    ratio: task.ratio ?? base.ratio ?? null,
    resolution: task.resolution ?? base.resolution ?? null,
    duration: task.duration != null ? String(task.duration) : base.duration,
    referenceImages: task.ref ? mapPaths(task.ref) : [],
    referenceVideos: task.refVideo ? mapPaths(task.refVideo) : [],
    referenceAudios: task.refAudio ? mapPaths(task.refAudio) : [],
    firstFrame: task.firstFrame ? resolveBatchPath(batchDir, task.firstFrame) : null,
    lastFrame: task.lastFrame ? resolveBatchPath(batchDir, task.lastFrame) : null,
    generateAudio: task.generateAudio ?? base.generateAudio,
    watermark: task.watermark ?? base.watermark,
    seed: task.seed ?? base.seed,
    cameraFixed: task.cameraFixed ?? base.cameraFixed,
    batchFile: null,
    taskId: null,
  };
}

async function prepareBatchTasks(args: CliArgs, config: Partial<ExtendConfig>): Promise<{ tasks: PreparedTask[]; jobs: number | null }> {
  const { tasks: inputs, jobs, batchDir } = await loadBatchTasks(args.batchFile!);
  if (!inputs.length) throw new Error("批量文件里没有任务");

  const prepared: PreparedTask[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const taskArgs = createTaskArgs(args, inputs[i]!, batchDir);
    const prompt = await loadPrompt(taskArgs);
    if (!prompt && !taskArgs.referenceImages.length && !taskArgs.firstFrame) throw new Error(`任务 ${i + 1} 缺少提示词与参考图`);
    if (!taskArgs.videoPath) throw new Error(`任务 ${i + 1} 缺少输出路径 video`);

    const provider = detectProvider(taskArgs, config);
    const module = await loadProviderModule(provider);
    const model = resolveModel(provider, taskArgs, config, module);
    const request = buildRequest(prompt, model, taskArgs, config);
    module.validateRequest?.(request);

    prepared.push({
      id: inputs[i]!.id || `task-${String(i + 1).padStart(2, "0")}`,
      request,
      provider,
      outputPath: ensureVideoExtension(taskArgs.videoPath),
      module,
    });
  }
  return { tasks: prepared, jobs: args.jobs ?? jobs };
}

/** 创建任务 + 轮询到完成。轮询超时按失败处理，但 taskId 会保留在结果里供续查。 */
async function runTask(task: PreparedTask, noWait: boolean): Promise<TaskResult> {
  const base: Omit<TaskResult, "success" | "attempts" | "error" | "taskId" | "url"> = {
    id: task.id,
    provider: task.provider,
    model: task.request.model,
    outputPath: task.outputPath,
  };
  console.error(`[${task.id}] 使用 ${task.provider} / ${task.request.model}`);
  console.error(
    `[${task.id}] 画幅 ${task.request.ratio} · 分辨率 ${task.request.resolution}（${pixelLabel(task.request.resolution, task.request.ratio)}）· 时长 ${task.request.duration === -1 ? "自适应" : `${task.request.duration}s`} · 音频 ${task.request.generateAudio ? "开" : "关"}`,
  );

  let attempts = 0;
  let lastError = "";
  let taskId: string | null = null;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      taskId = await task.module.createTask(task.request);
      console.error(`[${task.id}] 任务已创建：${taskId}（中断后可用 --task-id ${taskId} 续查）`);
      if (noWait) return { ...base, outputPath: null, taskId, url: null, success: true, attempts, error: null };

      const result = await pollUntilDone(task.module, taskId, task.request.model, task.id);
      const outputPath = await persist(result, task.outputPath, task.id);
      return { ...base, outputPath, taskId, url: result.url, success: true, attempts, error: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // 参数类错误重试没有意义，直接失败；仅网络/限流类错误才重试
      if (attempts >= MAX_ATTEMPTS || !isRetryable(lastError)) break;
      console.error(`[${task.id}] 第 ${attempts} 次失败，准备重试：${lastError}`);
      await sleep(3000);
    }
  }
  return { ...base, outputPath: null, taskId, url: null, success: false, attempts, error: lastError };
}

function isRetryable(message: string): boolean {
  return /429|超时|timeout|ECONNRESET|ETIMEDOUT|fetch failed|502|503|504/i.test(message);
}

async function pollUntilDone(module: ProviderModule, taskId: string, model: string, label: string): Promise<VideoResult> {
  const deadline = Date.now() + module.pollTimeoutMs;
  let ticks = 0;
  while (Date.now() < deadline) {
    try {
      return await module.pollTask(taskId, model);
    } catch (error) {
      if (!(error instanceof PendingError)) throw error;
      ticks += 1;
      // 每 6 次（约 30s）报一次进度，避免长任务看起来像卡死
      if (ticks % 6 === 0) console.error(`[${label}] 生成中（${error.state}），已等待 ${Math.round(ticks * module.pollIntervalMs / 1000)}s`);
      await sleep(module.pollIntervalMs);
    }
  }
  throw new Error(`轮询超时（${Math.round(module.pollTimeoutMs / 60000)} 分钟）。任务可能仍在生成，用 --task-id ${taskId} 续查`);
}

async function persist(result: VideoResult, outputPath: string, label: string): Promise<string | null> {
  if (!result.data) {
    console.error(`[${label}] 视频下载失败，但已生成。地址（有效期有限）：${result.url}`);
    return null;
  }
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, result.data);
  console.error(`[${label}] 已保存：${outputPath}（${(result.data.byteLength / 1024 / 1024).toFixed(1)} MB）`);
  return outputPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveWorkerCount(tasks: PreparedTask[], jobs: number | null, config: Partial<ExtendConfig>): number {
  // 优先级：--jobs / 批量文件 jobs > EXTEND.md > 环境变量 > 内置默认值
  const configured = config.batch?.max_workers || Number(process.env.YONGE_VIDEO_GEN_MAX_WORKERS) || DEFAULT_MAX_WORKERS;
  const providerCap = Math.min(...tasks.map((task) => DEFAULT_RATE_LIMITS[task.provider].concurrency));
  return Math.max(1, Math.min(jobs ?? providerCap, configured, tasks.length));
}

async function runBatch(tasks: PreparedTask[], jobs: number | null, config: Partial<ExtendConfig>, noWait: boolean): Promise<TaskResult[]> {
  const workers = resolveWorkerCount(tasks, jobs, config);
  console.error(`共 ${tasks.length} 个任务，并发 ${workers}`);
  const results: TaskResult[] = new Array(tasks.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      // 错开起始时间，避免同一秒打满方舟的 QPS
      if (index > 0) await sleep(DEFAULT_RATE_LIMITS[tasks[index]!.provider].startIntervalMs);
      results[index] = await runTask(tasks[index]!, noWait);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/** --task-id 模式：跳过创建，直接续查一个已存在的任务。 */
async function resumeTask(args: CliArgs, config: Partial<ExtendConfig>): Promise<TaskResult> {
  const provider = detectProvider(args, config);
  const module = await loadProviderModule(provider);
  const model = resolveModel(provider, args, config, module);
  const result = await pollUntilDone(module, args.taskId!, model, args.taskId!);
  const outputPath = args.videoPath ? await persist(result, ensureVideoExtension(args.videoPath), args.taskId!) : null;
  if (!args.videoPath) console.error(`任务完成。视频地址：${result.url ?? "（无 URL，请指定 --video 落盘）"}`);
  return {
    id: args.taskId!,
    provider,
    model,
    outputPath,
    taskId: args.taskId,
    url: result.url,
    success: true,
    attempts: 1,
    error: null,
  };
}

function report(results: TaskResult[], json: boolean): void {
  const succeeded = results.filter((item) => item.success);
  const failed = results.filter((item) => !item.success);
  if (json) {
    console.log(JSON.stringify({ total: results.length, succeeded: succeeded.length, failed: failed.length, results }, null, 2));
    return;
  }
  console.error(`\n完成 ${succeeded.length}/${results.length}`);
  for (const item of succeeded) {
    console.error(`  ✓ ${item.id} → ${item.outputPath ?? item.url ?? item.taskId}`);
  }
  for (const item of failed) {
    console.error(`  ✗ ${item.id}（${item.attempts} 次尝试）：${item.error}${item.taskId ? ` [taskId ${item.taskId}]` : ""}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  const config = loadConfig();

  if (args.taskId) {
    const result = await resumeTask(args, config);
    report([result], args.json);
    return;
  }

  const { tasks, jobs } = args.batchFile
    ? await prepareBatchTasks(args, config)
    : { tasks: [await prepareSingleTask(args, config)], jobs: null };

  const results = tasks.length > 1 ? await runBatch(tasks, jobs, config, args.noWait) : [await runTask(tasks[0]!, args.noWait)];
  report(results, args.json);
  if (results.some((item) => !item.success)) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
