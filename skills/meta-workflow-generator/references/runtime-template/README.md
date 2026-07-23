# 运行时模板目录

本目录包含为复杂工作流（≥6 节点）生成运行时层所需的所有模板文件。

## 文件列表

| 文件 | 用途 | 占位符 |
|---|---|---|
| `session-start.py` | SessionStart Hook 模板 | `{{workflow_name}}` |
| `inject-workflow-state.py` | UserPromptSubmit Hook 模板 | `{{workflow_name}}` |
| `inject-skill-context.py` | PreToolUse Hook 模板（可选） | `{{workflow_name}}` |
| `workflow.py` | 工作流管理脚本模板 | `{{workflow_name}}` |
| `context.py` | 上下文查询工具模板 | `{{workflow_name}}` |
| `state-schema.json` | state.json 的 JSON Schema | 无占位符 |
| `state-init-template.json` | state.json 初始化模板 | `{{workflow_name}}`, `{{timestamp}}`, 技能列表 |
| `context-manifest-template.jsonl` | context-manifest.jsonl 模板 | 技能信息、输出路径、字段列表 |
| `workflow-template.md` | workflow.md 完整模板 | 工作流信息、技能列表、状态块 |
| `session-memory-template.md` | session-memory.md 初始化模板 | `{{workflow_name}}` |

## 占位符说明

### 通用占位符

- `{{workflow_name}}`：工作流名称（如 `content-marketing`）
- `{{timestamp}}`：ISO 8601 格式时间戳
- `{{领域名称}}`：中文领域名称（如 "内容营销"）
- `{{一句话描述核心任务}}`：工作流的简短描述

### workflow-template.md 占位符

- `{{skill1_name}}`、`{{skill2_name}}`：技能名称
- `{{skill1_description}}`：技能描述
- `{{skill1_output}}`：技能产出物
- `{{output_path}}`：产出物文件路径
- `{{required_fields}}`：契约要求的字段列表
- `{{output_format}}`：输出格式说明
- `{{quality_requirement_N}}`：质量要求条目

### state-init-template.json 占位符

- `skill1`、`skill2`：替换为实际技能名称
- `dependencies`：依赖的上游技能列表
- `gate_level`：门禁级别（`strict`/`standard`/`relaxed`）

### context-manifest-template.jsonl 占位符

- `{{skill1_output_path}}`：技能1的输出路径
- `{{field1}}`、`{{field2}}`：关键字段名
- `{{skill2_dir}}`：技能2的目录名

## 生成流程

在 `meta-workflow-generator` 的步骤 4（编排与文件生成）中：

```python
if 节点数 >= 6:
    # 1. 创建目录结构
    create_directory(".workflow/hooks")
    create_directory(".workflow/runtime")
    create_directory(".workflow/scripts")
    
    # 2. 复制并替换 Hook 脚本
    for hook_script in ["session-start.py", "inject-workflow-state.py"]:
        template = read_template(f"runtime-template/{hook_script}")
        filled = template.replace("{{workflow_name}}", workflow_name)
        write_file(f".workflow/hooks/{hook_script}", filled)
        make_executable(f".workflow/hooks/{hook_script}")
    
    # 3. 生成 workflow.md
    template = read_template("runtime-template/workflow-template.md")
    filled = fill_workflow_template(template, skills, workflow_info)
    write_file(".workflow/workflow.md", filled)
    
    # 4. 生成管理脚本
    for script in ["workflow.py", "context.py"]:
        template = read_template(f"runtime-template/{script}")
        filled = template.replace("{{workflow_name}}", workflow_name)
        write_file(f".workflow/scripts/{script}", filled)
        make_executable(f".workflow/scripts/{script}")
    
    # 5. 初始化 state.json
    state = generate_initial_state(workflow_name, skills)
    write_json(".workflow/runtime/state.json", state)
    
    # 6. 生成 context-manifest.jsonl
    manifest = generate_context_manifest(skills)
    write_jsonl(".workflow/runtime/context-manifest.jsonl", manifest)
    
    # 7. 初始化 session-memory.md
    template = read_template("runtime-template/session-memory-template.md")
    filled = template.replace("{{workflow_name}}", workflow_name)
    write_file(".workflow/runtime/session-memory.md", filled)
```

## 替换规则

### 简单替换

直接用 `str.replace()` 替换：
- `{{workflow_name}}`
- `{{timestamp}}`

### 复杂替换

需要循环生成：
- `workflow-template.md` 中的状态块：为每个技能生成一个 `[workflow-state:skill{N}_in_progress]` 块
- `state-init-template.json` 中的 `skills` 对象：为每个技能生成一个条目
- `context-manifest-template.jsonl`：为每个技能生成多个上下文条目

### 条件生成

- `inject-skill-context.py`：仅在启用子代理模式时生成
- 编排技能：仅在有非线性依赖时生成

## 验证

生成后验证：
1. Hook 脚本可执行且语法正确：`python -m py_compile .workflow/hooks/*.py`
2. state.json 符合 schema：使用 `state-schema.json` 验证
3. workflow.md 状态块数量匹配：每个技能有对应的状态块
4. 管理脚本可运行：`python .workflow/scripts/workflow.py status`

## 示例输出

生成的 `.workflow/` 目录结构示例：

```
.workflow/
├── hooks/
│   ├── session-start.py         # 161 行
│   └── inject-workflow-state.py # 123 行
├── runtime/
│   ├── state.json               # 初始状态，所有技能 pending
│   ├── context-manifest.jsonl   # 每个技能 2-3 条上下文条目
│   └── session-memory.md        # 空白模板，等待自动填充
├── workflow.md                  # 200-400 行，包含所有状态块
└── scripts/
    ├── workflow.py              # 300 行，完整功能
    └── context.py               # 180 行，上下文查询
```

总大小：约 40KB（不含产出物）

## 更新日志

- 2026-07-22：初始版本，支持基础运行时层
- 未来：可能增加的功能
  - 并行执行监控（多技能同时 in_progress）
  - 性能指标追踪（每个技能的耗时）
  - 回滚机制（撤销某个技能的完成状态）
  - 可视化界面（Web UI 查看工作流状态）
