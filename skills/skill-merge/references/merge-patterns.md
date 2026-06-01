# 合并架构模式

对比三种常见的技能整合架构，帮助在 Phase 2 快速选型。

---

## 模式 A：插件层（Plugin Layer）

**结构（单源 1:1）：**
```
target-skill/
├── [existing files untouched]
└── extensions/
    ├── EXTENSIONS.md
    ├── data/
    ├── rules/
    ├── templates/
    └── scripts/
```

**结构（多源 N:1）：**
```
target-skill/
├── [existing files untouched]
└── extensions/
    ├── EXTENSIONS.md              ← 统一注册表，按来源分组记录
    ├── source-skill-a/            ← 每个源技能一个子目录
    │   ├── data/
    │   ├── rules/
    │   ├── templates/
    │   └── scripts/
    ├── source-skill-b/
    │   ├── data/
    │   └── scripts/
    └── shared/                    ← 可选：跨源共享的脚本/工具
        └── scripts/
```

**多源目录规则：**
- 每个源技能的迁移内容放入以源技能名命名的子目录
- `EXTENSIONS.md` 留在 `extensions/` 根目录，按来源分节记录
- 多个源共用的脚本（如通用搜索引擎）放入 `shared/scripts/`
- 回滚某个源 = 删除对应子目录 + 更新 EXTENSIONS.md

**单源时是否也用子目录？**
不强制。单源时平铺更简洁（路径短），符合 YAGNI 原则。
如果预期未来会有更多源合入，可以一开始就用子目录结构。

**适用场景：**
- 源技能有独立的数据资产（CSV、知识库）
- 源技能的能力可以表达为"查询"或"生成"操作
- 目标技能有明确的脚本调用模式

**优点：**
- 零侵入（只追加 SKILL.md）
- 完全可逆（删目录即恢复）
- 职责清晰（extensions/ = 全部新增内容）
- 多源时来源可追溯，可独立回滚单个源

**缺点：**
- 目录层级深（多源时 `extensions/source-a/scripts/search-data.mjs`）
- 需要在 SKILL.md 中声明激活条件
- 多源时 EXTENSIONS.md 维护成本略高

**实际案例：** Impeccable + UI-UX-Design 合并（单源，平铺结构）

---

## 模式 B：Sidecar 文件

**结构：**
```
target-skill/
├── SKILL.md
├── reference/
│   ├── [existing refs]
│   └── ext-*.md          ← 新增参考文档，用前缀区分
└── scripts/
    ├── [existing scripts]
    └── ext-*.mjs         ← 新增脚本，用前缀区分
```

**适用场景：**
- 源技能的能力主要是"知识型"（参考文档、规则清单）
- 不需要独立的数据层或搜索引擎
- 目标技能的 reference/ 加载机制已经成熟

**优点：**
- 与现有结构融合更紧密
- 无需额外的 EXTENSIONS.md 注册表
- 目标技能的命令可以自然地加载 `ext-*` 参考

**缺点：**
- 回滚需要逐个删除 `ext-*` 文件（不如删整个目录方便）
- 容易与现有文件混淆
- 不适合大量数据文件

**适用场景举例：** 将一套设计规则整合到已有技能的参考目录中

---

## 模式 C：适配器脚本（Adapter）

**结构：**
```
target-skill/
├── SKILL.md
├── scripts/
│   ├── [existing scripts]
│   └── adapter.mjs       ← 单个适配器，封装对源技能的调用
└── [source skill remains separate, adapter calls it]
```

**适用场景：**
- 源技能保持独立运行（不复制数据）
- 两个技能需要协作但不合并
- 源技能更新频繁，不想维护副本

**优点：**
- 源技能数据不重复存储
- 源技能可独立更新，目标技能自动受益
- 最小的文件增量

**缺点：**
- 运行时依赖源技能存在
- 源技能被删除则适配器失效
- 两个技能的耦合度高于模式 A

**适用场景举例：** 目标技能在特定步骤调用源技能的搜索脚本

---

## 选型决策树

```
多个源技能？
├─ 是 → 模式 A（Plugin Layer，多源子目录结构）
│       每个源一个子目录，shared/ 放共用脚本
└─ 否（单源）
    ├─ 源技能有大量数据资产（CSV/JSON/知识库）？
    │   ├─ 是 → 模式 A（Plugin Layer，平铺结构）
    │   └─ 否
    │       ├─ 源技能需要保持独立更新？
    │       │   ├─ 是 → 模式 C（Adapter）
    │       │   └─ 否
    │       │       ├─ 迁移内容主要是文档/规则？
    │       │       │   ├─ 是 → 模式 B（Sidecar）
    │       │       │   └─ 否 → 模式 A（Plugin Layer，平铺结构）
    │       │       └─
    │       └─
    └─
```

---

## 混合使用

实际项目中可能混合多种模式：

- **数据密集型能力** → Plugin Layer（extensions/data/）
- **知识型能力** → 写入 extensions/ 的 rules/ 或 templates/
- **需要保持同步的能力** → Adapter 调用源技能

关键是保持一致性：同一次合并中只用一种主模式，避免新增内容散落在多个不相关的位置。
