# 首次使用设置

本文件描述新用户的非阻塞式设置流程。

## 触发时机

在首个任务成功完成、且在偏好查找过程中未找到 EXTEND.md 时触发。

## 流程

1. 交付输出后，主动提出：

   > "要我把这些偏好保存下来，下次自动用？（平台、写作风格）"

2. 如果用户拒绝或忽略：什么都不做。同一会话中不再询问。

3. 如果用户同意，询问（合并为一个问题）：

   > "几个快速问题：
   > 1. 主要写哪个平台？（公众号 / 小红书 / 都写）
   > 2. 运营几个账号？如果多个，给每个起个名字和对应平台（如 wechat-tech、xhs-lifestyle）
   > 3. 每个账号的定位、目标受众、做账号的目的是什么？（可选，后续也能补充）
   > 4. 选一个内置风格作为起点？（lucid-tech / life-observer / sharp-commentary / warm-narrative），或者给我一篇你觉得最像你风格的文章，我提取后内联到配置里
   > 5. 保存到哪里？（项目目录 `.human-media-writer/EXTEND.md` 还是用户目录 `~/.human-media-writer/EXTEND.md`）"

4. 根据回答生成 EXTEND.md。以下为三种典型形态的最小骨架，仅示意"存成什么样"；完整字段定义、类型与继承规则以 [extend-schema.md](references/config/extend-schema.md) 为权威源，需要照抄结构时读它，此处不复制。

**单账号 + 内置预设**：

```yaml
---
wechat-tech:
  platform: wechat
  positioning: "泛技术人群的认知升级"
  audience: "25-40岁互联网从业者"
  purpose: "建立个人品牌"
  writing_style: lucid-tech
  long_threshold: 3000
---
```

**单账号 + 自定义风格（内联）**：

如果用户提供了写作样本，先分析样本、提取风格特征，然后按 extend-schema §custom_style 的完整模板把结果内联到 `custom_style` 字段中。骨架如下（字段仅示意，完整结构照抄 extend-schema）：

```yaml
---
wechat-tech:
  platform: wechat
  positioning: "泛技术人群的认知升级"
  audience: "25-40岁互联网从业者"
  purpose: "建立个人品牌"
  long_threshold: 3000
  custom_style:
    name: 我的风格
    # ... 其余字段结构见 extend-schema §custom_style
---
```

**多账号**：

```yaml
---
default_profile: wechat-tech
long_threshold: 3000

wechat-tech:
  platform: wechat
  positioning: "泛技术人群的认知升级"
  audience: "25-40岁互联网从业者"
  purpose: "建立个人品牌"
  writing_style: lucid-tech

xhs-lifestyle:
  platform: xiaohongshu
  positioning: "生活方式分享与好物种草"
  audience: "20-35岁女性，追求品质生活"
  purpose: "变现（带货/广告合作）"
  writing_style: life-observer
---
```

5. 保存到所选路径。确认：

   > "偏好已保存到 [path]。下次会自动加载。随时可以手动编辑这个文件调整设置。"
   >
   > （多账号时追加）"使用 `--profile <name>` 切换账号，或不加参数使用默认的 '[default_profile]'。"

## 创建自定义写作风格

当用户选择从样本提取风格，且提取完成后同意保存时：

1. 将提取结果按 extend-schema §custom_style 的完整 YAML 模板格式化
2. 以 `custom_style` 字段内联写入 EXTEND.md
3. 确认保存结果

无需外部文件——自定义风格直接嵌入配置。

## 设计理念

与翻译不同（翻译必须在开始前知道目标语言），创意写作可以基于上下文推断来进行。阻塞式设置会让一个本应快速、有主见的技能显得侵入性强。设置流程在用户已经体验到技能价值之后才提供。
