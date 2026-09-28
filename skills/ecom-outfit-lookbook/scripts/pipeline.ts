#!/usr/bin/env bun
/**
 * ecom-outfit-lookbook 编排脚本
 *
 * 只做确定性的机械劳动：建目录、读写 manifest、装配 batch.json、算待办、汇总失败。
 * 创作性判断（写方案、写场景提示词、判断漂移）由模型在 SKILL.md 流程里完成。
 *
 * 之所以把这些抽成脚本而非让模型每次现写：81 张图规模下手拼 JSON 与手算待办
 * 极易出错，且断点续跑的判断逻辑必须稳定可复现。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const MANIFEST = "manifest.json";
const MANIFEST_VERSION = 2;
const STAGES = ["00-input", "01-garment-triview", "02-plans", "03-shoots"] as const;
/** 与 SKILL.md「出图参数速查」保持一致。写成常量而非散在各处的字面值，避免两边再次跑偏。
 * 画幅由 slot 位置决定：前 mains 张是主图（1:1，抖店轮播位），后 details 张是详情图（3:4 竖版）。
 * 因此不再有全局 `--ar` —— 传了会被拒（见 cmdBuildBatch），静默忽略的话画幅错了要到几十张图出完才看得出来。
 * 注意 quality 存的是 baoyu-image-gen 的 `--quality` 预设值（normal|2k），不是分辨率数字。
 * normal = 1k 分辨率，2k = 2k 分辨率；传 "1k" 会被 baoyu 直接拒掉。 */
const MAIN_AR = "1:1";
const DETAIL_AR = "3:4";
const DEFAULT_MAINS = 5;
const DEFAULT_DETAILS = 3;
const DEFAULT_SHOT_QUALITY = "normal";
const VALID_QUALITY = ["normal", "2k"] as const;

/** 对比图（05 段）：左右分屏 + 全部文案由出图模型渲染的详情页物料。
 * 画幅沿用 DETAIL_AR：参考图 IMG_9783 本身是 1206×1600 = 3:4，与详情图位次一致，不必新增画幅。
 * 文件名前缀「详情图」是刻意的 —— doudian-publish 的 read-plan.py 按 startswith("详情图") 归类，
 * 这个名字能被直读契约命中。它随后的排序是纯字符串比较，"-"(0x2D) < "0"(0x30)，
 * 所以这张图会排到详情图第一位；对比图是转化钩子，第一屏正合适，故不改名规避。 */
const COMPARE_AR = DETAIL_AR;
const COMPARE_FILE = "详情图-对比图01.png";
const COMPARE_PROMPT_FILE = "compare-prompt.md";
/** 05 段是元提示词，一次产出全部方案的对比图提示词，落在这一个文件里（`---` 分块，块序即方案序）。
 * 与 plans.md 同构：跨方案的版式/调性差异只有在同一份文本里才审得出重复，拆成 N 个文件就看不见撞车。 */
const COMPARES_FILE = "compares.md";
/** 05 段声明行的四个维度。split-compares 按这四个键解析并查重，写进 compare-prompt.md 的只有正文。 */
const COMPARE_DIMS = ["版式", "调性", "文案", "拆分"] as const;

type Status = "pending" | "ok" | "failed";
type Classification = "仅上衣" | "仅下衣" | "套装";
type Kind = "main" | "detail" | "compare";

interface Artifact {
  stage: string;
  plan: number | null;
  /** 全局场景序号 1..(mains+details)，与 scenes.md 的 `## 场景 N` 块号一一对应。
   * 不改存 kind 内序号：那样「详情图01」的 scene 会是 1，prompt_file 指回 scenes.md#1，
   * 而 scenes.md#1 是第一张主图的提示词。 */
  scene: number | null;
  /** main = 主图（1:1），detail = 详情图（3:4），compare = 对比图（3:4，05 段产物）。
   * 落盘而非按 scene <= mains 现算：mains 事后被改过的话，
   * 现算会让已生成图的画幅归属跟着变，sync 判断就错了。 */
  kind: Kind | null;
  path: string;
  status: Status;
  prompt_file: string | null;
  refs: string[];
  provider: string | null;
  model: string | null;
  ar: string | null;
  quality: string | null;
  attempts: number;
  error: string | null;
  updated_at: string;
}

interface Manifest {
  version: number;
  product: string;
  created_at: string;
  /** Q14/Q15：只判一次并落盘。断点续跑时重判会导致同批图搭配规则不一致。 */
  classification: Classification | null;
  params: { plans: number; mains: number; details: number };
  artifacts: Artifact[];
}

const now = () => new Date().toISOString();
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 每方案的场景位次表：位置 → 命名 + 画幅。命名与 doudian-publish 的素材识别前缀
 * （read-plan.py 按 startswith("主图") / startswith("详情图") 归类）对齐，
 * 使 plan-NN/ 目录可直接被上品流程读走，不需要中间那道手工改名。 */
interface Slot {
  scene: number;
  kind: Kind;
  index: number;
  file: string;
  ar: string;
}

function slots(params: { mains: number; details: number }): Slot[] {
  const out: Slot[] = [];
  for (let i = 1; i <= params.mains; i++) {
    out.push({ scene: out.length + 1, kind: "main", index: i, file: `主图${pad2(i)}.png`, ar: MAIN_AR });
  }
  for (let i = 1; i <= params.details; i++) {
    out.push({ scene: out.length + 1, kind: "detail", index: i, file: `详情图${pad2(i)}.png`, ar: DETAIL_AR });
  }
  return out;
}

const sceneCount = (params: { mains: number; details: number }) => params.mains + params.details;

function manifestPath(workspace: string) {
  return join(workspace, MANIFEST);
}

function loadManifest(workspace: string): Manifest {
  const p = manifestPath(workspace);
  if (!existsSync(p)) {
    throw new Error(`manifest 不存在：${p}\n先运行 \`init\` 建立工作区。`);
  }
  const m = JSON.parse(readFileSync(p, "utf-8")) as Manifest;
  // v1 是 shot-N.png + params.scenes 的旧结构，不做自动迁移：
  // 迁移脚本要处理改名、画幅重算、manifest 重写三件事，代价高于重跑一次。
  if (m.version !== MANIFEST_VERSION) {
    throw new Error(
      `manifest 版本为 ${m.version}，本脚本要求 ${MANIFEST_VERSION}。\n` +
        `v1 是 shot-N.png / params.scenes 的旧结构，不提供自动迁移。\n` +
        `请新建工作区重跑，或手工把图改名为 主图NN.png / 详情图NN.png 并重写 manifest 后再 sync。`
    );
  }
  return m;
}

function saveManifest(workspace: string, m: Manifest) {
  writeFileSync(manifestPath(workspace), JSON.stringify(m, null, 2) + "\n", "utf-8");
}

function upsert(m: Manifest, a: Partial<Artifact> & { path: string; stage: string }) {
  const i = m.artifacts.findIndex((x) => x.path === a.path);
  const base: Artifact = {
    stage: a.stage,
    plan: a.plan ?? null,
    scene: a.scene ?? null,
    kind: a.kind ?? null,
    path: a.path,
    status: a.status ?? "pending",
    prompt_file: a.prompt_file ?? null,
    refs: a.refs ?? [],
    provider: a.provider ?? null,
    model: a.model ?? null,
    ar: a.ar ?? null,
    quality: a.quality ?? null,
    attempts: a.attempts ?? 0,
    error: a.error ?? null,
    updated_at: now(),
  };
  if (i === -1) m.artifacts.push(base);
  else m.artifacts[i] = { ...m.artifacts[i], ...base, attempts: a.attempts ?? m.artifacts[i].attempts };
  return base;
}

/** init：建目录骨架 + 空 manifest。幂等，已存在则只补缺失目录。 */
function cmdInit(workspace: string, product: string, plans: number, mains: number, details: number) {
  mkdirSync(workspace, { recursive: true });
  for (const s of STAGES) mkdirSync(join(workspace, s), { recursive: true });
  for (let i = 1; i <= plans; i++) {
    mkdirSync(join(workspace, "03-shoots", `plan-${pad2(i)}`), { recursive: true });
  }
  const p = manifestPath(workspace);
  if (existsSync(p)) {
    const m = loadManifest(workspace);
    console.log(`manifest 已存在，保留原有 ${m.artifacts.length} 条记录。`);
    console.log(`classification: ${m.classification ?? "(未判定)"}`);
    return;
  }
  const m: Manifest = {
    version: MANIFEST_VERSION,
    product,
    created_at: now(),
    classification: null,
    params: { plans, mains, details },
    artifacts: [],
  };
  saveManifest(workspace, m);
  console.log(`工作区就绪：${workspace}`);
  console.log(`商品：${product} / plans=${plans} / mains=${mains}（${MAIN_AR}） / details=${details}（${DETAIL_AR}）`);
  console.log(`每方案 ${sceneCount(m.params)} 张场景图，满配 ${1 + plans + plans * sceneCount(m.params)} 张。`);
  console.log(`下一步：把原始服饰图放进 ${join(workspace, "00-input")}/`);
}

/** classify：写入一次性的品类判定。已存在时需 --force 才覆盖。 */
function cmdClassify(workspace: string, value: string, force: boolean) {
  const valid: Classification[] = ["仅上衣", "仅下衣", "套装"];
  if (!valid.includes(value as Classification)) {
    throw new Error(`classification 必须是以下之一：${valid.join(" / ")}`);
  }
  const m = loadManifest(workspace);
  if (m.classification && !force) {
    throw new Error(
      `classification 已判定为「${m.classification}」。\n` +
        `重判会让同一批方案的搭配规则前后不一致。确实要改请加 --force，并删除已生成的方案与图片重跑。`
    );
  }
  m.classification = value as Classification;
  saveManifest(workspace, m);
  console.log(`classification = ${value}`);
}

/** 列出 00-input 下的原始图，作为全链色彩/图案的 ground truth。 */
function inputImages(workspace: string): string[] {
  const dir = join(workspace, "00-input");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
}

function planDir(workspace: string, plan: number) {
  return join(workspace, "03-shoots", `plan-${pad2(plan)}`);
}

/**
 * 按单独一行 `---` 切块。plans.md 与 scenes.md 都是单文件多块结构，
 * 拆分文件（plan-NN.md / scene-N.md）已废弃，切块逻辑只在这里实现一次。
 * 只认独占一行的 `---`，避免误伤正文里的破折号或 frontmatter 分隔。
 */
function splitBlocks(text: string): string[] {
  return text
    .split(/^\s*---\s*$/m)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

function readBlocks(file: string, label: string): string[] {
  if (!existsSync(file)) throw new Error(`${label} 不存在：${file}`);
  const blocks = splitBlocks(readFileSync(file, "utf-8"));
  if (!blocks.length) throw new Error(`${label} 里没有解析到任何块：${file}`);
  return blocks;
}

function plansFile(workspace: string) {
  return join(workspace, "02-plans", "plans.md");
}

function scenesFile(workspace: string, plan: number) {
  return join(planDir(workspace, plan), "scenes.md");
}

function comparesFile(workspace: string) {
  return join(workspace, "02-plans", COMPARES_FILE);
}

function comparePromptFile(workspace: string, plan: number) {
  return join(planDir(workspace, plan), COMPARE_PROMPT_FILE);
}

function compareImage(workspace: string, plan: number) {
  return join(planDir(workspace, plan), COMPARE_FILE);
}

/**
 * plan：打印某方案的完整块内容，供步骤 4、5 随提示词一并投喂。
 * 校验块内的 `## 方案 N` 编号：模型漏编或跳号时按块序取会错位，
 * 而错位的代价是整组图配错搭配，到出图后才发现就晚了。
 */
function cmdPlan(workspace: string, plan: number, loose: boolean) {
  const blocks = readBlocks(plansFile(workspace), "plans.md");
  const block = blocks[plan - 1];
  if (!block) throw new Error(`plans.md 只有 ${blocks.length} 个方案块，取不到方案 ${plan}。`);
  const declared = block.match(/^#{1,6}\s*方案\s*(\d+)/m)?.[1];
  if (declared === undefined) {
    const msg = `plans.md 第 ${plan} 块没有 \`## 方案 N\` 标题行，无法校验编号。`;
    if (!loose) throw new Error(`${msg}\n请按 02-plan-table.md 的输出格律补上标题，或加 --loose 强行按块序取。`);
    console.error(`⚠ ${msg}已按 --loose 按块序取。`);
  } else if (Number(declared) !== plan) {
    const msg = `编号错位：plans.md 第 ${plan} 块自称「方案 ${declared}」。`;
    if (!loose) {
      throw new Error(
        `${msg}\n按块序取会把方案 ${declared} 的搭配拿去生成方案 ${plan} 的图。\n` +
          `请先修正 plans.md 的编号（应从 1 连续递增），确实要按块序取请加 --loose。`
      );
    }
    console.error(`⚠ ${msg}已按 --loose 按块序取。`);
  }
  console.log(block);
}

/** 校验全量方案块的数量与编号，给 build-batch 与 status 复用。返回问题描述列表。 */
function checkPlanNumbering(workspace: string, expected: number): string[] {
  const file = plansFile(workspace);
  if (!existsSync(file)) return [`plans.md 不存在：${file}`];
  const blocks = splitBlocks(readFileSync(file, "utf-8"));
  const issues: string[] = [];
  if (blocks.length !== expected) {
    issues.push(`plans.md 解析出 ${blocks.length} 个方案块，与 plans=${expected} 不一致。`);
  }
  blocks.forEach((b, i) => {
    const declared = b.match(/^#{1,6}\s*方案\s*(\d+)/m)?.[1];
    if (declared === undefined) issues.push(`第 ${i + 1} 块缺 \`## 方案 N\` 标题行。`);
    else if (Number(declared) !== i + 1) issues.push(`第 ${i + 1} 块自称「方案 ${declared}」，编号错位。`);
  });
  return issues;
}

/**
 * 画面质感锚点：用户要的落点是「生活抓拍感」而非广告大片，但抓拍感不等于不讲究。
 *
 * 为什么必须由脚本统一附加、而不只写在 04 段里：04 段管的是场景词文本，
 * 而质感是渲染层的事——已经写好的 scenes.md 不重写也该生效；且模特三视图
 * （每张场景图的第一参考）本身是影棚白底规格图，那股精修质感会沿参考链
 * 一路传到全部成图上，需要在每张图提示词的末尾（近因位）反向压一次。
 *
 * 每条「允许不完美」都配了一条美感边界，两者要一起给：只给前半句时，
 * 模型会把「真实」理解成随机歪斜 + 写实的丑陋陈设（垃圾桶、脏污墙面、
 * 餐桌残渣），拿到的是可信但没人愿意存下来的图，作为电商素材同样是废的。
 *
 * 末尾那条裁决顺序是本段的关键：抓拍感一旦吃掉主商品的图案与版型可辨识度，
 * 整组图作为 A/B 素材就废了（见 SKILL.md 开篇的同一性优先原则）。
 * 所以真实感只许从光线、皮肤、构图、环境去拿，不许靠虚焦或遮挡换。
 */
const CANDID_TEXTURE = [
  "画面质感（贯穿全图，优先级低于上面的同一性要求）：",
  "• 真实的生活抓拍照片，像随身相机或手机在现场随手按下快门，不是广告大片、不是影棚商业硬照、不是渲染或插画；同时要拍得好看，是那种会被人存下来当穿搭参考的照片。",
  "• 现场自然光为主，允许光比偏大、局部轻微过曝或暗部压深、混合色温造成的轻微色偏；不要广告级柔光箱把人整体包裹得均匀无影。但这道光要有好看的落点：透过玻璃、纱帘、树叶或门缝形成有形状的光斑，落在发梢、肩线、手背或裙摆边缘，在轮廓上勾出亮边。",
  "• 皮肤保留真实纹理：毛孔、绒毛、肤色轻微不均、真实的妆容状态；不磨皮、不液化、不做瓷感或油亮高光。",
  "• 构图允许不完美：轻微手持倾斜、主体非居中、边缘自然裁切；成像允许暗部细颗粒与轻微的镜头呼吸感，但不到显得脏或糊的程度。偏移与倾斜要有取景意图、顺着现场的门框窗棂台阶或光影边界走，不是随机歪斜；画面分前中后层次，留白留给有内容的部分。",
  "• 环境保留真实生活痕迹，不做清场式布景，但陈设是挑过的、与整体色调是一伙的（藤椅、陶杯、旧木桌面、棉麻织物、绿植与叶影、随手放着的书这一类）；不出现垃圾桶、垃圾袋、脏污或破损墙面、餐桌残渣、乱堆的纸箱与塑料件、彩色广告与荧光招牌。环境主色控制在 2–3 个，与主商品的颜色形成呼应或干净的对撞。",
  "• 人物是进行中的自然状态，不是摆好的标准姿势与标准笑容；同时取这个动作里线条好看的那一帧——重心明确、手腕手指放松、颈肩角度自然、身体有一条顺的曲线。",
  "• 但以上抓拍痕迹一律不得牺牲主商品的可辨识度：主商品的颜色、图案与版型必须始终清晰可见、不被虚焦、遮挡或阴影吞掉。两者冲突时以主商品清晰为准。",
].join("\n");

/**
 * Q8 参考图链路：喂三张并声明优先级。
 * 原图当色彩锚点，避免漂移单向累积；模特图定身份与配饰；服装三视图补背面细节。
 */
const REF_PRIORITY = [
  "参考图使用优先级（冲突时按此裁决）：",
  "1. 人物身份、脸型、发型、妆容、鞋履与配饰 → 以模特三视图为准；",
  "2. 主商品的颜色、图案、面料质感 → 以原始服饰图为准；",
  "3. 主商品的背面结构与局部细节 → 以服装三视图为准。",
  "以上参考图均为同一主商品与同一模特，请保持该同一性，不要重新设计或生成相似的新主体。",
  "",
  CANDID_TEXTURE,
].join("\n");

/** 对比图专用的尾部强制条款：比 REF_PRIORITY 多两件事 —— 两幅同一人、主商品两幅一致，
 * 再加上汉字质量与「不画平台控件」。
 *
 * 为什么由脚本统一附加而不靠 05 段让模型逐块写：这几条是这类图最容易崩的地方
 * （模型倾向把分屏画成两个不同的人），而元提示词一次要写 N 块，局部漏写几乎必然。
 * 附在末尾也占了近因位置。措辞用「各幅」而非「左右两幅」：版式现在可能是上下双栅或大小主次，
 * 写死「左右」会与正文的版式描述相矛盾。 */
const COMPARE_REF_PRIORITY = [
  "参考图使用优先级（冲突时按此裁决）：",
  "1. 人物身份、脸型、发型、妆容 → 以模特三视图为准，画面里的各幅必须是这同一个人；",
  "2. 主商品的颜色、图案、面料质感 → 以原始服饰图为准，各幅的主商品必须完全一致；",
  "3. 主商品的背面结构与局部细节 → 以服装三视图为准。",
  "以上参考图均为同一主商品与同一模特，请保持该同一性，不要重新设计或生成相似的新主体。",
  "",
  "无论上文的版式如何描述，这几条一律适用：",
  "• 画面里必须出现同一位模特的两种穿法，不得只画一个人，也不得画成两个不同的人；各幅姿态要有差异，不要镜像复制。",
  "• 主商品在各幅中都完整可见、不被包袋或手臂遮住关键图案区，版型与图案不变；差异只来自补充单品与随之变化的鞋履、配饰。",
  "• 全部中文必须是笔画清晰、结构正确的真实汉字，横排，不出现错字、缺笔、伪汉字或乱码字形；不竖排、不倾斜、不做立体特效。",
  "• 只渲染提示词里给定的文字，不自行增删改写；不出现价格、店名、水印、二维码、英文点缀。",
  "• 不绘制任何 CTA 按钮、跳转入口、平台界面控件或社交浮标（收藏/评论/分享/关闭图标）——那些属于投放位的平台界面，不属于素材本身。",
  "• 真人写实摄影质感，自然柔和光线，避免强烈的 AI 痕迹与失真感；排版部分干净锐利，边距均匀对齐。",
].join("\n");

function cmdRefs(workspace: string, plan: number) {
  const m = loadManifest(workspace);
  const refs = [
    join(planDir(workspace, plan), "model-triview.png"),
    ...inputImages(workspace),
    join(workspace, "01-garment-triview", "garment-triview.png"),
  ].filter((p) => existsSync(p));
  console.log(JSON.stringify({ classification: m.classification, refs, priority: REF_PRIORITY }, null, 2));
}

/**
 * compare-input：把 05 段元提示词需要的全量输入一次摆出来
 * （品类 + 方案总数 + 全部方案的三个风格字段）。
 *
 * 为什么是全量而不是逐方案：对比图要在版式、调性、文案、拆分四个维度上相互错开，
 * 而「错开」是个跨方案的约束——模型只看得到单个方案时无法知道往哪里错，
 * 结果就是方案 3 和方案 7 各自选了同一套版式。
 *
 * 抽字段是纯机械的（正则取行），交给脚本；设计与措辞是创作性的，仍由模型完成。
 */
function cmdCompareInput(workspace: string) {
  const m = loadManifest(workspace);
  const blocks = readBlocks(plansFile(workspace), "plans.md");
  const field = (block: string, name: string) =>
    block.match(new RegExp(`^[-\\s]*${name}：(.+)$`, "m"))?.[1]?.trim() ?? null;

  const digest = blocks.map((block, i) => ({
    plan: i + 1,
    风格名称: field(block, "风格名称"),
    主打关键词: field(block, "主打关键词"),
    风格调性: field(block, "风格调性"),
  }));
  const missing = digest.filter((d) => !d.风格名称 || !d.主打关键词 || !d.风格调性).map((d) => d.plan);

  console.log(
    JSON.stringify(
      {
        classification: m.classification,
        plan_count: m.params.plans,
        plan_digest: digest,
        用法:
          `classification → {{CLASSIFICATION}}，plan_count → {{PLAN_COUNT}}，plan_digest → {{PLAN_DIGEST}}；` +
          `整段 05 元提示词一次投喂，输出写入 ${comparesFile(workspace)}，再跑 split-compares 拆到各方案目录。`,
      },
      null,
      2
    )
  );
  if (blocks.length !== m.params.plans) {
    console.error(`⚠ plans.md 解析出 ${blocks.length} 块，与 plans=${m.params.plans} 不一致。先修 plans.md。`);
  }
  if (missing.length) {
    console.error(`⚠ 方案 ${missing.join("、")} 缺风格字段，元提示词会失去这几组的调性依据。`);
  }
}

/** 从 compares.md 的一个块里拆出维度声明与正文。
 * 声明行只给人审阅与查重用，不进 compare-prompt.md：
 * 把「版式：上下双栏」这种元信息喂给出图模型，它可能把这几个字当成要渲染的文案画到图上。 */
function parseCompareBlock(block: string) {
  const declared = block.match(/^#{1,6}\s*对比图\s*(\d+)/m)?.[1];
  const dims: Record<string, string> = {};
  const lines = block.split("\n");
  let bodyStart = 0;
  lines.forEach((line, i) => {
    if (/^#{1,6}\s*对比图/.test(line)) bodyStart = Math.max(bodyStart, i + 1);
    for (const d of COMPARE_DIMS) {
      const v = line.match(new RegExp(`^[-*\\s]*${d}：(.+)$`))?.[1]?.trim();
      if (v) {
        dims[d] = v;
        bodyStart = i + 1;
      }
    }
  });
  return {
    declared: declared === undefined ? null : Number(declared),
    dims,
    body: lines.slice(bodyStart).join("\n").trim(),
  };
}

/**
 * split-compares：把 compares.md 按块拆到各 plan-NN/compare-prompt.md，并顺带查重。
 *
 * 为什么要拆而不是让 build-compare 直接读 compares.md：
 * 单方案返工时要能只改那一张的提示词，而不是回去动一份 N 块的大文件；
 * compare-prompt.md 也是 manifest 里 prompt_file 指向的可追溯快照。
 * 已存在的文件默认不覆盖——你可能已手改过某一张，默认覆写会默默吃掉那次修正。
 *
 * 两级严重度，且**全部校验都在任何写盘之前跑完**：
 * errors（块数不符、编号错位、缺维度声明、正文为空、四元组完全重复）会中止且一个字都不写——
 * 编号错位意味着把 A 方案的文案配到 B 方案的图上，先写一半再报错等于留下一地要人工比对的错配文件；
 * warnings（单一维度占比过半）只提示，因为有时确实是该批方案的风格所限，该不该改由用户定。
 */
function cmdSplitCompares(workspace: string, force: boolean) {
  const m = loadManifest(workspace);
  const blocks = readBlocks(comparesFile(workspace), COMPARES_FILE);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (blocks.length !== m.params.plans) {
    errors.push(`${COMPARES_FILE} 解析出 ${blocks.length} 块，与 plans=${m.params.plans} 不一致。`);
  }

  const seen = new Map<string, number[]>();
  const perDim = new Map<string, Map<string, number>>(COMPARE_DIMS.map((d) => [d, new Map()]));
  const parsed = blocks.map((block, i) => {
    const plan = i + 1;
    const { declared, dims, body } = parseCompareBlock(block);
    if (declared === null) errors.push(`第 ${plan} 块缺 \`## 对比图 N\` 标题行。`);
    else if (declared !== plan) errors.push(`第 ${plan} 块自称「对比图 ${declared}」，编号错位。`);

    const missDims = COMPARE_DIMS.filter((d) => !dims[d]);
    if (missDims.length) errors.push(`第 ${plan} 块缺维度声明：${missDims.join("、")}。`);
    if (!body) errors.push(`第 ${plan} 块的提示词正文为空。`);

    const key = COMPARE_DIMS.map((d) => dims[d] ?? "?").join(" | ");
    seen.set(key, [...(seen.get(key) ?? []), plan]);
    for (const d of COMPARE_DIMS) {
      const v = dims[d];
      if (v) perDim.get(d)!.set(v, (perDim.get(d)!.get(v) ?? 0) + 1);
    }
    return { plan, key, body };
  });

  // 四元组完全重复 = 这两张图除了模特脸基本一样，在 A/B 里白占一个位，等于少测一个版式。
  for (const [key, plans] of seen) {
    if (plans.length > 1) errors.push(`方案 ${plans.join("、")} 的四元组完全相同（${key}）。`);
  }
  const half = Math.max(1, Math.ceil(blocks.length / 2));
  for (const [d, bucket] of perDim) {
    for (const [v, n] of bucket) {
      if (n > half) warnings.push(`维度「${d}」的「${v}」占了 ${n}/${blocks.length}，超过一半，差异度不够。`);
    }
  }

  if (errors.length) {
    console.error(`✗ ${COMPARES_FILE} 有 ${errors.length} 处问题，未写入任何文件：`);
    for (const e of errors) console.error(`  ${e}`);
    console.error(`\n回去改 ${COMPARES_FILE} 再重跑，不要绕过——它是对比图提示词的唯一事实来源。`);
    process.exit(1);
  }

  let written = 0;
  let skipped = 0;
  for (const { plan, key, body } of parsed) {
    const out = comparePromptFile(workspace, plan);
    if (existsSync(out) && !force) {
      skipped++;
      continue;
    }
    mkdirSync(planDir(workspace, plan), { recursive: true });
    writeFileSync(out, body + "\n", "utf-8");
    written++;
    console.log(`✓ 方案 ${pad2(plan)}  ${key}  → ${out}`);
  }

  console.log(`\n写入 ${written} 份，跳过已存在 ${skipped} 份${skipped && !force ? "（要覆盖加 --force）" : ""}。`);
  if (warnings.length) {
    console.error(`\n⚠ 差异度告警（${warnings.length}）：`);
    for (const w of warnings) console.error(`  ${w}`);
    console.error(`拿给用户定：改 ${COMPARES_FILE} 后加 --force 重拆，或就这样出图。`);
  }
}

/**
 * build-compare：把已落盘的 compare-prompt.md 装配成 batch.json。
 *
 * 与 build-batch 分开而非塞进同一个位次表：对比图不属于 mains/details 的位次序列，
 * 混进去会让「满配张数」「位次映射」两处计算都要开分支，而它的提示词来源也不同
 * （每方案一个独立文件，不是 scenes.md 的某一块）。
 */
function cmdBuildCompare(workspace: string, output: string, onlyPlans: number[] | null, quality: string) {
  const m = loadManifest(workspace);
  if (!VALID_QUALITY.includes(quality as (typeof VALID_QUALITY)[number])) {
    throw new Error(
      `--quality 只能是 ${VALID_QUALITY.join(" 或 ")}，收到「${quality}」。\n` +
        `这是 baoyu-image-gen 的预设名而非分辨率数字；要 1k 请用 normal，传 "1k" 会被 baoyu 拒掉。`
    );
  }
  const garment = join(workspace, "01-garment-triview", "garment-triview.png");
  const inputs = inputImages(workspace);
  const tasks: Array<Record<string, unknown>> = [];
  let skipped = 0;

  const plans = onlyPlans ?? Array.from({ length: m.params.plans }, (_, i) => i + 1);

  for (const plan of plans) {
    const model = join(planDir(workspace, plan), "model-triview.png");
    if (!existsSync(model)) {
      console.error(`⚠ 方案 ${plan}：缺 model-triview.png，跳过对比图。`);
      continue;
    }
    const promptFile = comparePromptFile(workspace, plan);
    if (!existsSync(promptFile)) {
      console.error(`⚠ 方案 ${plan}：缺 ${COMPARE_PROMPT_FILE}，跳过对比图。先按 05 段拼好提示词落盘。`);
      continue;
    }
    const img = compareImage(workspace, plan);
    const rec = m.artifacts.find((a) => a.path === img);
    if (rec?.status === "ok" && existsSync(img)) {
      skipped++;
      continue;
    }
    const refs = [model, ...inputs, garment].filter((p) => existsSync(p));
    const prompt = readFileSync(promptFile, "utf-8").trim() + "\n\n" + COMPARE_REF_PRIORITY;
    tasks.push({ prompt, image: img, ref: refs, ar: COMPARE_AR, quality });
    upsert(m, {
      stage: "03-shoots",
      plan,
      scene: null,
      kind: "compare",
      path: img,
      status: "pending",
      prompt_file: promptFile,
      refs,
      ar: COMPARE_AR,
      quality,
    });
  }

  writeFileSync(output, JSON.stringify({ tasks }, null, 2) + "\n", "utf-8");
  saveManifest(workspace, m);
  console.log(`batch 已写入：${output}`);
  console.log(`待生成对比图 ${tasks.length} 张 @ ${COMPARE_AR}，跳过已完成 ${skipped} 张。（quality=${quality}）`);
  if (tasks.length === 1) console.log(`建议：--batchfile ${output}（单张，顺序出即可）`);
  else if (tasks.length) console.log(`建议：--batchfile ${output} --jobs 10`);
}

/**
 * build-batch：把某方案（或全部方案）待生成的场景图装配成 baoyu-image-gen 的 batch.json。
 * 已 ok 的跳过 —— 这就是断点续跑：删图 + 改 pending 即可返工。
 * 画幅不接参数，按 slot 位置取 MAIN_AR / DETAIL_AR。
 */
function cmdBuildBatch(workspace: string, output: string, onlyPlans: number[] | null, quality: string) {
  const m = loadManifest(workspace);
  if (!VALID_QUALITY.includes(quality as (typeof VALID_QUALITY)[number])) {
    throw new Error(
      `--quality 只能是 ${VALID_QUALITY.join(" 或 ")}，收到「${quality}」。\n` +
        `这是 baoyu-image-gen 的预设名而非分辨率数字；要 1k 请用 normal，传 "1k" 会被 baoyu 拒掉。`
    );
  }
  const planBlocks = readBlocks(plansFile(workspace), "plans.md");
  const table = slots(m.params);
  const expectedScenes = sceneCount(m.params);

  /**
   * 场景锚点：从方案块的「拍摄场景：」字段机械拼接，追加在场景块正文之后。
   * 同一方案的全部场景 prompt 都带上同一句地点描述，
   * 让同组图的地点类型、光线调性在文字层收敛，
   * 缓解各 shot 独立生成导致的环境互不相认。
   * 这只是文字约束，不保证几何级一致；要严格一致需把前序 shot 加进参考链（漂移风险）。
   */
  const sceneAnchor = (plan: number): string => {
    const block = planBlocks[plan - 1];
    const field = block?.match(/^[-\s]*拍摄场景：(.+)$/m)?.[1]?.trim();
    return field ? `拍摄场景是在${field}。` : "";
  };

  const garment = join(workspace, "01-garment-triview", "garment-triview.png");
  const inputs = inputImages(workspace);
  const tasks: Array<Record<string, unknown>> = [];
  let skipped = 0;

  for (const issue of checkPlanNumbering(workspace, m.params.plans)) {
    console.error(`⚠ ${issue}`);
  }

  const plans = onlyPlans ?? Array.from({ length: m.params.plans }, (_, i) => i + 1);

  for (const plan of plans) {
    const dir = planDir(workspace, plan);
    const model = join(dir, "model-triview.png");
    if (!existsSync(model)) {
      console.error(`⚠ 方案 ${plan}：缺 model-triview.png，跳过该方案的场景图。`);
      continue;
    }
    const refs = [model, ...inputs, garment].filter((p) => existsSync(p));

    const scenesPath = scenesFile(workspace, plan);
    if (!existsSync(scenesPath)) {
      console.error(`⚠ 方案 ${plan}：缺 scenes.md，跳过该方案的场景图。`);
      continue;
    }
    const blocks = splitBlocks(readFileSync(scenesPath, "utf-8"));
    if (blocks.length !== expectedScenes) {
      console.error(
        `⚠ 方案 ${plan}：scenes.md 解析出 ${blocks.length} 个场景块，与 mains+details=${expectedScenes} 不一致，按较小值取。`
      );
    }

    for (const slot of table) {
      const img = join(dir, slot.file);
      const rec = m.artifacts.find((a) => a.path === img);
      if (rec?.status === "ok" && existsSync(img)) {
        skipped++;
        continue;
      }
      const block = blocks[slot.scene - 1];
      if (!block) {
        console.error(`⚠ 方案 ${plan} 场景 ${slot.scene}：${basename(scenesPath)} 中缺该场景块，跳过 ${slot.file}。`);
        continue;
      }
      const anchor = sceneAnchor(plan);
      const tail = anchor ? `${anchor}\n\n` : "";
      const prompt = block + tail + REF_PRIORITY;
      tasks.push({ prompt, image: img, ref: refs, ar: slot.ar, quality });
      upsert(m, {
        stage: "03-shoots",
        plan,
        scene: slot.scene,
        kind: slot.kind,
        path: img,
        status: "pending",
        prompt_file: `${scenesPath}#${slot.scene}`,
        refs,
        ar: slot.ar,
        quality,
      });
    }
  }

  writeFileSync(output, JSON.stringify({ tasks }, null, 2) + "\n", "utf-8");
  saveManifest(workspace, m);
  const mainCount = tasks.filter((t) => t.ar === MAIN_AR).length;
  console.log(`batch 已写入：${output}`);
  console.log(
    `待生成 ${tasks.length} 张（主图 ${mainCount} @ ${MAIN_AR}，详情图 ${tasks.length - mainCount} @ ${DETAIL_AR}），` +
      `跳过已完成 ${skipped} 张。（quality=${quality}）`
  );
  if (tasks.length) console.log(`建议：--batchfile ${output} --jobs 10`);
}

/** sync：按磁盘实况回填状态。图在即 ok，图不在且原为 ok 则退回 pending（人工删图返工入口）。 */
function cmdSync(workspace: string) {
  const m = loadManifest(workspace);
  let ok = 0;
  let reverted = 0;
  for (const a of m.artifacts) {
    if (!a.path.match(/\.(png|jpe?g|webp)$/i)) continue;
    const there = existsSync(a.path);
    if (there && a.status !== "ok") {
      a.status = "ok";
      a.error = null;
      a.updated_at = now();
      ok++;
    } else if (!there && a.status === "ok") {
      a.status = "pending";
      a.updated_at = now();
      reverted++;
    }
  }
  saveManifest(workspace, m);
  console.log(`同步完成：新增确认 ${ok} 张，退回待生成 ${reverted} 张。`);
}

/** mark：单条状态更新，供失败汇总与人工返工使用。 */
function cmdMark(workspace: string, path: string, status: Status, error: string | null) {
  const m = loadManifest(workspace);
  const a = m.artifacts.find((x) => x.path === path || x.path.endsWith(path));
  if (!a) throw new Error(`manifest 中找不到：${path}`);
  a.status = status;
  a.error = error;
  if (status === "failed") a.attempts += 1;
  a.updated_at = now();
  saveManifest(workspace, m);
  console.log(`${a.path} → ${status}`);
}

/** status：进度总览 + 失败清单，批末汇总用。 */
function cmdStatus(workspace: string) {
  const m = loadManifest(workspace);
  const imgs = m.artifacts.filter((a) => /\.(png|jpe?g|webp)$/i.test(a.path));
  const by = (s: Status) => imgs.filter((a) => a.status === s).length;
  const perPlan = sceneCount(m.params);
  const expected = 1 + m.params.plans + m.params.plans * perPlan;
  const table = slots(m.params);

  console.log(`商品：${m.product}`);
  console.log(`品类判定：${m.classification ?? "(未判定)"}`);
  console.log(
    `参数：plans=${m.params.plans} mains=${m.params.mains}（${MAIN_AR}） details=${m.params.details}（${DETAIL_AR}）`
  );
  console.log(`图片：ok ${by("ok")} / pending ${by("pending")} / failed ${by("failed")}（满配 ${expected} 张，不含可选的对比图）`);

  const planIssues = checkPlanNumbering(workspace, m.params.plans);
  if (planIssues.length) {
    console.log(`\nplans.md 问题（${planIssues.length}）：`);
    for (const i of planIssues) console.log(`  ⚠ ${i}`);
  }

  // 对比图提示词是先落到一份 compares.md 再拆的，块数对不上就会漏方案，在总览里直接看得到。
  const cmpFile = comparesFile(workspace);
  if (existsSync(cmpFile)) {
    const n = splitBlocks(readFileSync(cmpFile, "utf-8")).length;
    console.log(`对比图提示词：${COMPARES_FILE} ${n}/${m.params.plans} 块`);
  }

  for (let p = 1; p <= m.params.plans; p++) {
    const dir = planDir(workspace, p);
    const model = existsSync(join(dir, "model-triview.png")) ? "模特图✓" : "模特图✗";
    const scenesPath = scenesFile(workspace, p);
    const scenes = existsSync(scenesPath)
      ? `场景词 ${splitBlocks(readFileSync(scenesPath, "utf-8")).length}/${perPlan}`
      : "场景词✗";
    const dot = (slot: Slot) => (existsSync(join(dir, slot.file)) ? "●" : "○");
    const mainDots = table.filter((s) => s.kind === "main").map(dot).join("");
    const detailDots = table.filter((s) => s.kind === "detail").map(dot).join("");
    // 对比图是可选产物，两个状态都要能看出来：提示词落盘了没有、图出了没有。
    const cmpImg = existsSync(compareImage(workspace, p));
    const cmpPrompt = existsSync(comparePromptFile(workspace, p));
    const cmp = cmpImg ? "●" : cmpPrompt ? "◐" : "○";
    console.log(`  方案 ${pad2(p)}  ${model}  ${scenes}  主图 ${mainDots} 详情 ${detailDots} 对比 ${cmp}`);
  }

  const failed = imgs.filter((a) => a.status === "failed");
  if (failed.length) {
    console.log(`\n失败清单（${failed.length}）：`);
    for (const f of failed) console.log(`  ${f.path}  attempts=${f.attempts}  ${f.error ?? ""}`);
  }
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * 废弃参数一律报错退出，不静默忽略。
 * 静默忽略的后果是你写了 `--ar 3:4` 以为全批竖版，实际前 5 张仍是方图，
 * 而这要到几十张图出完才看得出来；`--scenes 8` 被忽略则会让人以为规模已设好。
 */
const RETIRED: Record<string, string> = {
  ar: `画幅现在由 slot 位置决定：前 mains 张主图固定 ${MAIN_AR}，后 details 张详情图固定 ${DETAIL_AR}。请去掉 --ar。`,
  scenes: `--scenes 已拆成 --mains（默认 ${DEFAULT_MAINS}）与 --details（默认 ${DEFAULT_DETAILS}）。`,
  "main-ar": `主图画幅固定为 ${MAIN_AR}，不接参数。`,
  "detail-ar": `详情图画幅固定为 ${DETAIL_AR}，不接参数。`,
};

/** compare-fields 已被 compare-input 取代：05 段从模板变成元提示词，不再逐方案取字段填占位符。
 * 单独列出而不归到 RETIRED：它是子命令不是参数，而且要告知新流程的两步。 */
const RETIRED_COMMANDS: Record<string, string> = {
  "compare-fields": `已被 compare-input + split-compares 取代。\n05 段现在是元提示词：先 compare-input 取全量输入，一次生成全部方案的对比图提示词到 02-plans/${COMPARES_FILE}，再 split-compares 拆到各方案目录。`,
};

function rejectRetiredFlags() {
  for (const [flag, why] of Object.entries(RETIRED)) {
    if (process.argv.includes(`--${flag}`)) throw new Error(`--${flag} 已废弃。${why}`);
  }
}

function main() {
  const cmd = process.argv[2];
  const workspace = resolve(arg("workspace", ".")!);
  const has = (f: string) => process.argv.includes(`--${f}`);
  rejectRetiredFlags();
  if (cmd && RETIRED_COMMANDS[cmd]) throw new Error(`${cmd} 已废弃。${RETIRED_COMMANDS[cmd]}`);

  switch (cmd) {
    case "init":
      cmdInit(
        workspace,
        arg("product", basename(workspace))!,
        Number(arg("plans", "10")),
        Number(arg("mains", String(DEFAULT_MAINS))),
        Number(arg("details", String(DEFAULT_DETAILS)))
      );
      break;
    case "classify":
      cmdClassify(workspace, arg("value")!, has("force"));
      break;
    case "refs":
      cmdRefs(workspace, Number(arg("plan")));
      break;
    case "compare-input":
      cmdCompareInput(workspace);
      break;
    case "split-compares":
      cmdSplitCompares(workspace, has("force"));
      break;
    case "build-compare": {
      const only = arg("plans-only");
      cmdBuildCompare(
        workspace,
        arg("output", join(workspace, "batch-compare.json"))!,
        only ? only.split(",").map(Number) : null,
        arg("quality", DEFAULT_SHOT_QUALITY)!
      );
      break;
    }
    case "plan":
      cmdPlan(workspace, Number(arg("plan")), has("loose"));
      break;
    case "build-batch": {
      const only = arg("plans-only");
      cmdBuildBatch(
        workspace,
        arg("output", join(workspace, "batch.json"))!,
        only ? only.split(",").map(Number) : null,
        arg("quality", DEFAULT_SHOT_QUALITY)!
      );
      break;
    }
    case "sync":
      cmdSync(workspace);
      break;
    case "mark":
      cmdMark(workspace, arg("path")!, arg("status", "ok") as Status, arg("error", null as unknown as string) ?? null);
      break;
    case "status":
      cmdStatus(workspace);
      break;
    default:
      console.log(
        [
          "用法：bun pipeline.ts <command> --workspace <dir> [options]",
          "",
          `  init          --product <名称> [--plans 10] [--mains ${DEFAULT_MAINS}] [--details ${DEFAULT_DETAILS}]`,
          "  classify      --value 仅上衣|仅下衣|套装 [--force]          写入一次性品类判定",
          "  plan          --plan <N> [--loose]                        从 plans.md 取出该方案的完整块（校验编号）",
          "  refs          --plan <N>                                   输出该方案的参考图清单与优先级",
          `  build-batch   [--plans-only 1,2] [--output <path>] [--quality ${DEFAULT_SHOT_QUALITY}]`,
          "  compare-input                                              取 05 段元提示词的全量输入（品类 + 全部方案风格字段）",
          `  split-compares [--force]                                   把 02-plans/${COMPARES_FILE} 拆到各 plan-NN/${COMPARE_PROMPT_FILE} 并查重`,
          `  build-compare [--plans-only 1,2] [--output <path>] [--quality ${DEFAULT_SHOT_QUALITY}]`,
          "  sync                                                       按磁盘实况回填状态",
          "  mark          --path <路径> --status ok|pending|failed [--error <文本>]",
          "  status                                                     进度总览 + 失败清单",
          "",
          `画幅不可配：主图NN.png = ${MAIN_AR}，详情图NN.png = ${DETAIL_AR}，${COMPARE_FILE} = ${COMPARE_AR}。`,
        ].join("\n")
      );
      process.exit(cmd ? 1 : 0);
  }
}

try {
  main();
} catch (e) {
  // 干净的错误输出：这些错误多半是流程顺序问题或保护性拒绝，
  // 堆栈会把真正要读的那句话埋掉。
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
