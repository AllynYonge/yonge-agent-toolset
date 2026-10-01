# 统一配置约定 - 所有带配置技能共用的格式与改造流程

## 核心定位

[config-design.md](config-design.md) 讲的是设计配置时该怎么思考。本文件把那些原则落实成一套固定约定：目录、文件名、格式、优先级、密钥位置、模板和读取脚本。所有技能都按这一套来写，用户只需要记住一个位置、一种写法，也不会因为两个技能的规则不同而配错。

> 本文件是 SKILL.md `## 统一配置（--config）` 小节的展开。思考原则以 config-design.md 为准，本文件只写约定与流程，两边不重复。

---

## 一、约定

| 项目 | 约定 |
|------|------|
| 根目录 | 项目级 `<cwd>/.yonge/.yonge-skills/`，用户级 `~/.yonge/.yonge-skills/` |
| 偏好文件 | `<根目录>/<技能名>/EXTEND.md`，内容写在 YAML front matter 里，第一个字段是 `version: 1` |
| 查找顺序 | 项目 → 用户，命中第一个就停，**不合并** |
| 密钥文件 | `<根目录>/.env`，所有技能共用一份 |
| 密钥位置 | **只能**放 .env，禁止写进 EXTEND.md。读取脚本发现密钥类字段会直接报错 |
| 优先级 | CLI 参数 > EXTEND.md > 进程环境变量 > 项目 .env > 用户 .env > 内置默认值 |
| 字段命名 | 默认值用 `default_*`；按后端区分的用映射 `default_model.<后端>`；批量相关放 `batch.*` |
| 环境变量命名 | 技能私有的用 `<技能名大写>_<字段>`（如 `YONGE_VIDEO_GEN_MAX_WORKERS`）；第三方服务的密钥沿用服务商通行名称（如 `ARK_API_KEY`） |
| 多账号密钥 | `<前缀>_<别名>_<KEY>`，找不到时回退到 `<前缀>_<KEY>`。别名转大写，非字母数字转下划线 |
| 门禁范围 | 只阻断需要配置的操作；不需要配置的操作（如只预览主题）直接放行 |
| 生效回显 | 每次执行前输出一行实际使用的关键值，例如「使用 ark / 模型 X」 |

两条容易违反直觉的规则，写文档时要明确举例：

- **EXTEND.md 覆盖环境变量**：EXTEND.md 写了 `default_model.ark: A`，环境变量写了 `ARK_VIDEO_MODEL=B`，最终用 A。
- **项目 .env 覆盖用户 .env**：两边都写了 `ARK_API_KEY` 时，用项目级的。

## 二、目标技能需要的文件

| 文件 | 来源模板 | 内容 |
|------|----------|------|
| SKILL.md 中的「步骤 0」 | `assets/config-kit/step0.md` | 查找表、两种情况的处理、字段概括、密钥位置、优先级，约 15 行 |
| `references/config/preferences-schema.md` | `assets/config-kit/preferences-schema.md` | 字段表（字段 / 类型 / 默认值 / 等价环境变量 / 说明）、最小示例、密钥变量表、写法限制 |
| `references/config/first-time-setup.md` | `assets/config-kit/first-time-setup.md` | 流程 A 完整设置、流程 B 只补问缺失字段 |
| `scripts/lib/skill-config.ts` | `assets/config-kit/skill-config.ts` | 读取脚本，**原样复制，不在目标技能里修改** |
| `scripts/lib/skill-config.test.ts` | `assets/config-kit/skill-config.test.ts` | 可选，随读取脚本一起复制 |

没有脚本的技能（只靠模型读文件执行）也需要前三个文件。读取脚本可以只当检查工具用：`bun <路径>/skill-config.ts --skill <技能名>`。

### 读取脚本的用法

```ts
import { getConfigValue, loadDotEnv, loadSkillConfig, pickFirst, resolveSecret } from "./lib/skill-config";

loadDotEnv(); // 先把 .env 写入环境，进程里已有的变量不覆盖
const { config, source, warnings } = loadSkillConfig({
  skill: "my-skill",
  allowedKeys: ["version", "default_provider", "default_model.*", "batch.max_workers"],
});
for (const warning of warnings) console.error(`警告：${warning}`);

// 按优先级链取值：CLI > EXTEND.md > 环境变量 > 内置默认值
const model = pickFirst(args.model, getConfigValue(config, "default_model.ark") as string, process.env.ARK_VIDEO_MODEL, "builtin");

const apiKey = resolveSecret({ prefix: "ARK", key: "API_KEY" });
if (!apiKey) throw new Error("缺少 ARK_API_KEY，请写入 ~/.yonge/.yonge-skills/.env");
```

`source` 为 `null` 表示没找到 EXTEND.md。脚本要不要因此停止，由技能自己决定：模型调用时已经在步骤 0 完成了首次设置，脚本里通常直接用默认值继续即可。

读取脚本已经处理的事情，目标技能**不要**再自己实现：路径查找、YAML 子集解析、版本检查、密钥字段检查、未知字段警告、.env 优先级。

---

## 三、工作流

### 模式 A：给新技能加配置

在 `--create` 的访谈问题 7 确认需要配置之后进入。

1. **列出配置项**：逐项判断属于哪一类，并填进字段表草稿
   - 偏好（默认值、开关、路径）→ EXTEND.md
   - 密钥 → .env，只记录变量名
   - 每次都会变的输入 → CLI 参数，不进配置
2. **确定门禁范围**：哪些操作必须先有配置，哪些可以直接执行
3. **套用模板**：按第二节生成文件，替换全部 `{{...}}` 占位
4. **接入读取脚本**（有脚本时）：复制 `skill-config.ts`，用 `pickFirst` 按优先级链取值，`allowedKeys` 与字段表保持一致
5. **验证**：执行第四节的检查清单

### 模式 B：把已有技能改成统一约定

1. **盘点现状**：列出技能实际读取的所有配置入口，包括文档写了的和代码实际读取的，两边都要查。逐项记录路径、格式、优先级、密钥位置
2. **对照约定**：对第一节的每一行给出「已符合 / 需修改」，需修改的写明当前做法与目标做法
3. **展示差异，等待确认**：把差异表交给用户，确认后再改。涉及用户已有配置文件的移动或重写时，单独说明影响
4. **处理旧配置迁移**：见下文「旧配置迁移」
5. **修改**：文档用模板重写配置相关段落；代码用读取脚本替换原有的路径查找、解析和 .env 加载逻辑，删掉被替换的旧函数
6. **验证**：执行第四节的检查清单，并用用户现有的真实配置跑一遍检查命令

### 旧配置迁移

- 路径变化时，文档写明旧路径；不在读取脚本里加旧路径兼容，避免读取规则再次分叉
- 用户已有的配置文件，**由用户确认后**再移动或改写，不擅自处理
- 密钥原来写在 EXTEND.md 里的：告诉用户改写到 .env 的哪个变量名，由用户自己写入，之后再删除 EXTEND.md 里的对应字段

---

## 四、检查清单

文档：

- [ ] 步骤 0 的查找表、优先级与本文件第一节一致
- [ ] 字段表有「等价环境变量」列；默认值只出现在字段表里
- [ ] 示例只写需要覆盖的字段，并有一个最小示例
- [ ] 可选值清单只写在一处，其它位置引用
- [ ] 任何文档、示例里都没有密钥的值，也没有把密钥写进 EXTEND.md 的示例
- [ ] 首次设置的最后一问是保存位置；有流程 B
- [ ] 写法限制一节与读取脚本的实际行为一致

代码（有脚本时）：

- [ ] `scripts/lib/skill-config.ts` 与 skill-creator 中的版本完全一致（`diff` 无输出）
- [ ] 没有残留的自写路径查找、YAML 解析、.env 加载
- [ ] `allowedKeys` 覆盖字段表里的全部字段
- [ ] 每次执行前输出实际使用的关键值

实测：

- [ ] `bun scripts/lib/skill-config.ts --skill <技能名>` 能读取到用户的真实配置
- [ ] 删除（或改名）EXTEND.md 后，技能会进入首次设置，而不是静默使用默认值
- [ ] 写一个未知字段、一个数组、一个 `api_key: x`，分别得到警告、报错、报错
- [ ] 技能原有的测试全部通过
