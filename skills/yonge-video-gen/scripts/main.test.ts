import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTaskArgs, detectProvider, loadConfig, parseArgs, toExtendConfig } from "./main";
import { parseExtend } from "./lib/skill-config";
import {
  assertReferenceCounts,
  audioReferenceError,
  buildPromptText,
  normalizeDuration,
  normalizeRatio,
  normalizeResolution,
  pixelLabel,
  videoReferenceError,
} from "./lib/seedance";
import type { CliArgs } from "./types";

const baseArgs = (): CliArgs => parseArgs([]);

describe("parseArgs", () => {
  test("解析基础参数", () => {
    const args = parseArgs(["--prompt", "推镜", "--video", "out.mp4", "--ratio", "16:9", "--duration", "8"]);
    expect(args.prompt).toBe("推镜");
    expect(args.videoPath).toBe("out.mp4");
    expect(args.ratio).toBe("16:9");
    expect(args.duration).toBe("8");
  });

  test("多值参数收集到下一个 flag 为止", () => {
    const args = parseArgs(["--ref", "a.png", "b.png", "--ref-video", "c.mp4", "--no-audio"]);
    expect(args.referenceImages).toEqual(["a.png", "b.png"]);
    expect(args.referenceVideos).toEqual(["c.mp4"]);
    expect(args.generateAudio).toBe(false);
  });

  test("位置参数兜底为提示词", () => {
    expect(parseArgs(["一只猫", "在跑"]).prompt).toBe("一只猫 在跑");
  });

  test("拒绝未知参数与非法供应商", () => {
    expect(() => parseArgs(["--nope"])).toThrow("未知参数");
    expect(() => parseArgs(["--provider", "midjourney"])).toThrow("不支持的供应商");
  });
});

describe("参数归一化", () => {
  test("画幅：枚举直通，WxH 就近映射，其他回落 adaptive", () => {
    expect(normalizeRatio("9:16")).toBe("9:16");
    expect(normalizeRatio("1920x1080")).toBe("16:9");
    expect(normalizeRatio("1080x1920")).toBe("9:16");
    expect(normalizeRatio("auto")).toBe("adaptive");
    expect(normalizeRatio(null)).toBe("adaptive");
  });

  test("分辨率：语义档位映射到具体值", () => {
    expect(normalizeResolution("low")).toBe("480p");
    expect(normalizeResolution("high")).toBe("720p");
    expect(normalizeResolution("1080")).toBe("1080p");
    expect(normalizeResolution("4k")).toBe("720p"); // 不支持的值回落默认
  });

  test("时长：-1 保留，其余裁剪到 4-15", () => {
    expect(normalizeDuration("-1")).toBe(-1);
    expect(normalizeDuration("2")).toBe(4);
    expect(normalizeDuration("99")).toBe(15);
    expect(normalizeDuration(null)).toBe(5);
  });

  test("像素标签", () => {
    expect(pixelLabel("1080p", "16:9")).toBe("1920x1080");
    expect(pixelLabel("720p", "adaptive")).toContain("自适应");
  });
});

describe("提示词编号", () => {
  test("无素材时原样返回", () => {
    expect(buildPromptText({ prompt: " 推镜 ", images: [], videos: [], audios: [] })).toBe("推镜");
  });

  test("有素材时前置编号表", () => {
    const text = buildPromptText({ prompt: "走进房间", images: ["a", "b"], videos: ["c"], audios: [] });
    expect(text).toContain("图片1、图片2、视频1");
    expect(text).toContain("走进房间");
  });
});

describe("参考素材校验", () => {
  test("数量越界报错", () => {
    expect(() => assertReferenceCounts({ images: new Array(10).fill("a"), videos: [], audios: [] })).toThrow("最多 9 张");
    expect(() => assertReferenceCounts({ images: [], videos: new Array(4).fill("a"), audios: [] })).toThrow("最多 3 条");
  });

  test("音频不能单独存在", () => {
    expect(() => assertReferenceCounts({ images: [], videos: [], audios: ["a.mp3"] })).toThrow("至少搭配");
    expect(() => assertReferenceCounts({ images: ["a.png"], videos: [], audios: ["a.mp3"] })).not.toThrow();
  });

  test("视频格式/体积/时长/尺寸逐项拦截", () => {
    expect(videoReferenceError([{ mimeType: "video/webm" }])).toContain("mp4/mov");
    expect(videoReferenceError([{ bytes: 300 * 1024 * 1024 }])).toContain("200MB");
    expect(videoReferenceError([{ durationMs: 1000 }])).toContain("2-15 秒");
    expect(videoReferenceError([{ mimeType: "video/mp4", width: 100, height: 100 }])).toContain("300-6000");
    expect(videoReferenceError([{ mimeType: "video/mp4", width: 4000, height: 800 }])).toContain("宽高比");
    expect(videoReferenceError([{ mimeType: "video/mp4", width: 1920, height: 1080, durationMs: 5000 }])).toBe("");
  });

  test("参考视频总时长上限", () => {
    expect(videoReferenceError([{ durationMs: 9000 }, { durationMs: 9000 }])).toContain("总时长");
  });

  test("音频体积与时长", () => {
    expect(audioReferenceError([{ bytes: 20 * 1024 * 1024 }])).toContain("15MB");
    expect(audioReferenceError([{ durationMs: 5000 }])).toBe("");
  });
});

describe("EXTEND.md 解析", () => {
  const extend = `---
version: 1
default_provider: ark
default_ratio: "9:16"
default_resolution: 1080p
default_duration: 8
default_generate_audio: false
default_watermark: null
default_model:
  ark: doubao-seedance-1-0-pro-250528
  openai: null
batch:
  max_workers: 2
---

正文说明不参与解析。`;

  test("解析并转换为 ExtendConfig", () => {
    const config = toExtendConfig(parseExtend(extend));
    expect(config.default_provider).toBe("ark");
    expect(config.default_ratio).toBe("9:16");
    expect(config.default_resolution).toBe("1080p");
    expect(config.default_duration).toBe(8);
    expect(config.default_generate_audio).toBe(false);
    expect(config.default_watermark).toBeNull();
    expect(config.default_model?.ark).toBe("doubao-seedance-1-0-pro-250528");
    expect(config.default_model?.openai).toBeNull();
    expect(config.batch?.max_workers).toBe(2);
  });

  test("值类型不对时报错，不静默丢弃", () => {
    expect(() => toExtendConfig(parseExtend("---\nversion: 1\ndefault_provider: foo\n---\n"))).toThrow("default_provider");
    expect(() => toExtendConfig(parseExtend("---\nversion: 1\ndefault_duration: long\n---\n"))).toThrow("default_duration");
    expect(() => toExtendConfig(parseExtend("---\nversion: 1\ndefault_watermark: yes\n---\n"))).toThrow("default_watermark");
  });

  test("loadConfig：项目级 EXTEND.md 优先，项目 .env 覆盖用户 .env，进程环境变量不被覆盖", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "yvg-config-"));
    const cwd = path.join(base, "project");
    const home = path.join(base, "home");
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    write(path.join(cwd, ".yonge/.yonge-skills/.yonge-video-gen/EXTEND.md"), "---\nversion: 1\ndefault_resolution: 1080p\n---\n");
    write(path.join(home, ".yonge/.yonge-skills/.yonge-video-gen/EXTEND.md"), "---\nversion: 1\ndefault_resolution: 480p\n---\n");
    write(path.join(cwd, ".yonge/.yonge-skills/.env"), "YVG_TEST_SHARED=project\n");
    write(path.join(home, ".yonge/.yonge-skills/.env"), "YVG_TEST_SHARED=user\nYVG_TEST_PROCESS=user\n");
    process.env.YVG_TEST_PROCESS = "process";
    try {
      expect(loadConfig({ cwd, home }).default_resolution).toBe("1080p");
      expect(process.env.YVG_TEST_SHARED).toBe("project");
      expect(process.env.YVG_TEST_PROCESS).toBe("process");
    } finally {
      delete process.env.YVG_TEST_SHARED;
      delete process.env.YVG_TEST_PROCESS;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("loadConfig：密钥写进 EXTEND.md 时报错", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "yvg-config-"));
    const file = path.join(base, "home/.yonge/.yonge-skills/.yonge-video-gen/EXTEND.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\nversion: 1\nark_api_key: abc\n---\n");
    try {
      expect(() => loadConfig({ cwd: path.join(base, "project"), home: path.join(base, "home") })).toThrow("密钥");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("detectProvider", () => {
  test("显式指定优先", () => {
    expect(detectProvider({ ...baseArgs(), provider: "openai" }, { default_provider: "ark" })).toBe("openai");
  });

  test("参考视频/音频/尾帧强制走方舟", () => {
    expect(detectProvider({ ...baseArgs(), referenceVideos: ["a.mp4"] }, { default_provider: "openai" })).toBe("ark");
    expect(detectProvider({ ...baseArgs(), lastFrame: "z.png" }, { default_provider: "openai" })).toBe("ark");
  });

  test("无凭证时给出可操作报错", () => {
    const ark = process.env.ARK_API_KEY;
    const openai = process.env.OPENAI_API_KEY;
    delete process.env.ARK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => detectProvider(baseArgs(), {})).toThrow("未找到可用凭证");
    } finally {
      if (ark) process.env.ARK_API_KEY = ark;
      if (openai) process.env.OPENAI_API_KEY = openai;
    }
  });
});

describe("createTaskArgs", () => {
  test("相对路径按 batch 目录解析，引用型地址原样保留", () => {
    const args = createTaskArgs(
      baseArgs(),
      { id: "s01", promptFiles: ["p/s01.md"], video: "out/s01.mp4", ref: ["kf/a.png", "asset://abc", "https://x/y.png"] },
      "/tmp/batch",
    );
    expect(args.promptFiles).toEqual(["/tmp/batch/p/s01.md"]);
    expect(args.videoPath).toBe("/tmp/batch/out/s01.mp4");
    expect(args.referenceImages).toEqual(["/tmp/batch/kf/a.png", "asset://abc", "https://x/y.png"]);
  });

  test("任务级参数覆盖全局，未给则继承", () => {
    const base = { ...baseArgs(), ratio: "16:9", resolution: "720p" };
    const args = createTaskArgs(base, { video: "a.mp4", ratio: "9:16", duration: 8 }, "/tmp");
    expect(args.ratio).toBe("9:16");
    expect(args.resolution).toBe("720p");
    expect(args.duration).toBe("8");
  });
});
