# Meta-Workflow-Generator 文件清单

## 目录结构

```
meta-workflow-generator/
├── SKILL.md                          # 主技能文件（已更新）
├── CHANGELOG.md                      # 版本变更日志（新增）
├── IMPLEMENTATION_SUMMARY.md         # 实施总结（新增）
├── QUICKSTART.md                     # 快速上手指南（新增）
├── FILES.md                          # 本文件（新增）
└── references/
    ├── architecture-patterns.md      # 架构模式（已有）
    ├── branching-patterns.md         # 分支模式（已有）
    ├── domain-examples.md            # 领域示例（已有）
    ├── orchestrator-template.md      # 编排器模板（已更新）
    ├── skill-template.md             # 技能模板（已更新）
    ├── validation-guide.md           # 验证指南（已更新）
    ├── runtime-guide.md              # 运行时指南（新增）
    └── runtime-template/             # 运行时模板目录（新增）
        ├── README.md
        ├── session-start.py
        ├── inject-workflow-state.py
        ├── inject-skill-context.py
        ├── workflow.py
        ├── context.py
        ├── state-schema.json
        ├── state-init-template.json
        ├── context-manifest-template.jsonl
        ├── workflow-template.md
        ├── session-memory-template.md
        └── validate-templates.py
```

---

## 文件详细说明

### 根目录

#### SKILL.md（已更新）
- **类型**：主技能定义
- **大小**：~40 KB
- **变更**：
  - 更新"模式选择"表格，增加"运行时层"列
  - 新增"运行时层特性"段落（5 个子段落）
  - 新增平台兼容性说明
- **用途**：定义 meta-workflow-generator 的功能和使用方法

#### CHANGELOG.md（新增）
- **类型**：Markdown
- **大小**：~30 KB
- **内容**：
  - 版本 2.0 详细变更日志
  - 核心功能说明
  - 技术细节
  - 测试覆盖
  - 已知限制
  - 未来改进
- **用途**：追踪版本变更历史

#### IMPLEMENTATION_SUMMARY.md（新增）
- **类型**：Markdown
- **大小**：~25 KB
- **内容**：
  - 实施完成状态
  - 实施清单
  - 核心功能验证
  - 模板验证结果
  - 设计决策记录
  - 实施统计
- **用途**：总结本次优化迭代的实施情况

#### QUICKSTART.md（新增）
- **类型**：Markdown
- **大小**：~20 KB
- **内容**：
  - 5 分钟快速体验
  - 核心概念
  - 常见场景
  - 调试技巧
  - 常见问题
- **用途**：帮助用户快速上手运行时层

#### FILES.md（本文件，新增）
- **类型**：Markdown
- **大小**：~10 KB
- **内容**：完整的文件清单和说明
- **用途**：导航和文件结构参考

---

### references/ 目录

#### runtime-guide.md（新增）
- **类型**：Markdown
- **大小**：~60 KB
- **内容**：
  - 运行时层概述
  - Hook 机制详解
  - state.json 格式说明
  - workflow.py 命令参考
  - context.py 命令参考
  - 调试方法
  - 跨平台兼容性
  - 会话记忆系统
  - 质量门系统
  - 常见问题
  - 进阶用法
- **用途**：运行时层的完整技术文档

#### skill-template.md（已更新）
- **类型**：Markdown
- **大小**：~15 KB
- **变更**：
  - 新增"门禁检查"章节
  - 新增"运行时集成"章节
  - 新增"脚本增强"章节
- **用途**：生成单个技能时的模板

#### validation-guide.md（已更新）
- **类型**：Markdown
- **大小**：~12 KB
- **变更**：
  - 新增"运行时层验证"章节
  - 新增 Hook 脚本测试方法
  - 新增状态文件验证方法
  - 新增完整端到端测试流程
  - 新增常见问题修正方法
- **用途**：工作流交付后的验证方法

#### orchestrator-template.md（已更新）
- **类型**：Markdown
- **大小**：~25 KB
- **变更**：
  - 新增"与运行时层的关系"章节
- **用途**：生成编排器技能时的模板

#### architecture-patterns.md（已有，未变更）
- **类型**：Markdown
- **大小**：~10 KB
- **用途**：工作流架构模式参考

#### branching-patterns.md（已有，未变更）
- **类型**：Markdown
- **大小**：~15 KB
- **用途**：分支条件和异常处理设计模式

#### domain-examples.md（已有，未变更）
- **类型**：Markdown
- **大小**：~20 KB
- **用途**：领域工作流完整示例

---

### references/runtime-template/ 目录（新增）

#### README.md
- **类型**：Markdown
- **大小**：~15 KB
- **内容**：
  - 文件列表
  - 占位符说明
  - 生成流程
  - 替换规则
  - 验证方法
  - 示例输出
  - 更新日志
- **用途**：运行时模板使用说明

#### session-start.py
- **类型**：Python 脚本
- **行数**：161
- **依赖**：Python 3.7+ 标准库
- **功能**：
  - SessionStart Hook 实现
  - 注入工作流全景和当前状态
  - 平台检测
  - Windows 兼容性处理
- **占位符**：`{{workflow_name}}`

#### inject-workflow-state.py
- **类型**：Python 脚本
- **行数**：123
- **依赖**：Python 3.7+ 标准库
- **功能**：
  - UserPromptSubmit Hook 实现
  - 解析 workflow.md 状态块
  - 注入当前状态提示
  - 平台适配（Gemini 使用 BeforeAgent）
- **占位符**：`{{workflow_name}}`

#### inject-skill-context.py
- **类型**：Python 脚本
- **行数**：152
- **依赖**：Python 3.7+ 标准库
- **功能**：
  - PreToolUse Hook 实现（可选）
  - 读取 context-manifest.jsonl
  - 注入技能特定上下文
  - 内容长度限制（2000 字符）
- **占位符**：`{{workflow_name}}`

#### workflow.py
- **类型**：Python 脚本
- **行数**：300
- **依赖**：Python 3.7+ 标准库
- **功能**：
  - 工作流管理命令行工具
  - 命令：status / start / next / skip / report / archive
  - state.json 读写
  - 依赖检查
  - 进度追踪
- **占位符**：`{{workflow_name}}`

#### context.py
- **类型**：Python 脚本
- **行数**：180
- **依赖**：Python 3.7+ 标准库
- **功能**：
  - 上下文查询命令行工具
  - 命令：list / load / validate
  - context-manifest.jsonl 读取
  - 文件内容加载
  - 完整性验证
- **占位符**：`{{workflow_name}}`

#### state-schema.json
- **类型**：JSON Schema
- **行数**：80
- **功能**：
  - state.json 的 JSON Schema 定义
  - 字段类型和约束
  - 枚举值定义
- **占位符**：无

#### state-init-template.json
- **类型**：JSON 模板
- **行数**：20
- **功能**：
  - state.json 初始化模板
  - 默认状态（所有技能 pending）
- **占位符**：
  - `{{workflow_name}}`
  - `{{timestamp}}`
  - 技能列表（动态生成）

#### context-manifest-template.jsonl
- **类型**：JSONL 模板
- **行数**：5
- **功能**：
  - 上下文清单模板
  - 示例条目
- **占位符**：
  - `{{skill1_output_path}}`
  - `{{skill2_dir}}`
  - `{{field1}}`, `{{field2}}`

#### workflow-template.md
- **类型**：Markdown 模板
- **行数**：200
- **功能**：
  - workflow.md 完整模板
  - 包含状态提示块
  - 质量门配置表格
  - 分支路由说明
  - 使用说明
- **占位符**：
  - `{{workflow_name}}`
  - `{{领域名称}}`
  - `{{skill1_name}}`, `{{skill2_name}}`, ...
  - `{{skill1_description}}`, ...
  - `{{skill1_output}}`, ...
  - 等 40+ 个占位符

#### session-memory-template.md
- **类型**：Markdown 模板
- **行数**：30
- **功能**：
  - 会话记忆初始化模板
  - 记录格式说明
  - 示例条目
- **占位符**：`{{workflow_name}}`

#### validate-templates.py
- **类型**：Python 脚本
- **行数**：120
- **依赖**：Python 3.7+ 标准库
- **功能**：
  - 验证所有模板文件
  - Python 语法检查
  - JSON/JSONL 格式检查
  - Markdown 编码检查
  - 占位符检测
- **占位符**：无

---

## 文件统计

### 新增文件

| 类型 | 数量 | 总大小/行数 |
|---|---|---|
| Markdown 文档（根目录） | 4 | ~85 KB |
| Markdown 文档（references/） | 1 | ~60 KB |
| Markdown 模板 | 3 | ~230 行 |
| Python 脚本 | 6 | ~1,036 行 |
| JSON 文件 | 2 | ~100 行 |
| JSONL 文件 | 1 | ~5 行 |
| **总计** | **17** | **~145 KB / ~1,371 行代码** |

### 更新文件

| 文件 | 新增内容 |
|---|---|
| SKILL.md | ~3 KB（3 个段落） |
| skill-template.md | ~2 KB（3 个章节） |
| validation-guide.md | ~3 KB（1 个章节） |
| orchestrator-template.md | ~1 KB（1 个段落） |
| **总计** | **~9 KB** |

### 总计

- **新增文件**：17 个
- **更新文件**：4 个
- **新增代码**：~1,371 行
- **新增文档**：~154 KB

---

## 文件依赖关系

```
SKILL.md
  └── references/
       ├── runtime-guide.md
       │    └── runtime-template/
       │         ├── session-start.py
       │         ├── inject-workflow-state.py
       │         ├── inject-skill-context.py
       │         ├── workflow.py
       │         ├── context.py
       │         ├── state-schema.json
       │         ├── state-init-template.json
       │         ├── context-manifest-template.jsonl
       │         ├── workflow-template.md
       │         └── session-memory-template.md
       ├── skill-template.md
       ├── validation-guide.md
       │    └── runtime-template/validate-templates.py
       └── orchestrator-template.md
```

---

## 使用场景映射

| 用户需求 | 参考文件 |
|---|---|
| 快速上手运行时层 | QUICKSTART.md |
| 了解版本变更 | CHANGELOG.md |
| 深入理解运行时机制 | references/runtime-guide.md |
| 查看实施情况 | IMPLEMENTATION_SUMMARY.md |
| 了解文件结构 | FILES.md（本文件） |
| 生成工作流时参考 | SKILL.md |
| 生成技能时参考 | references/skill-template.md |
| 验证工作流 | references/validation-guide.md |
| 生成编排器时参考 | references/orchestrator-template.md |
| 了解模板结构 | references/runtime-template/README.md |
| 验证模板 | references/runtime-template/validate-templates.py |

---

## 维护指南

### 添加新的 Hook 脚本

1. 在 `references/runtime-template/` 创建新脚本
2. 更新 `runtime-template/README.md` 文件列表
3. 更新 `references/runtime-guide.md` Hook 机制章节
4. 在 `validate-templates.py` 中添加验证

### 更新模板

1. 修改 `references/runtime-template/` 中的对应模板
2. 运行验证：`python references/runtime-template/validate-templates.py`
3. 更新 `runtime-template/README.md` 占位符说明
4. 更新 `CHANGELOG.md` 记录变更

### 添加新的管理命令

1. 修改 `workflow.py` 或 `context.py`
2. 更新 `references/runtime-guide.md` 命令参考
3. 更新 `QUICKSTART.md` 常见场景
4. 运行验证确保语法正确

---

## 许可证

所有文件遵循 MIT License。

---

## 贡献

本次优化迭代参考了 Trellis 工作流设计，在 meta-workflow-generator v1.0 基础上实现。
