# 子代理委派模块接入说明

可整体复制到其他 Skill 的子代理委派规范：准备任务、选平台规则、主↔子交互模式、等待与检查结果、无子代理时的备用处理。  
业务规则仍由目标 Skill 定义。

## 目录

```text
subagents/
├── README.md
├── protocol.md
├── task-template.md
└── adapters/
    ├── codex.md
    ├── claude-code.md
    ├── opencode.md
    └── generic.md
```

| 文件 | 用途 |
|------|------|
| `protocol.md` | 共用委派规范 |
| `task-template.md` | 子代理任务说明模板 |
| `adapters/*` | 各 Agent 环境差异与失败处理 |

## 复制到另一个 Skill

1. 复制整个 `subagents/`，保持内部结构。  
2. 在 `SKILL.md` 或业务流程中加入口说明。  
3. 用 `task-template.md` 在目标 Skill 中定义具体任务（建议独立文件，如 `references/tasks/`）。  
4. 不要把业务规则写进 `protocol.md` 或适配器。

推荐路径：`<target-skill>/references/subagents/`

## 接入文本

将 `[SUBAGENT_DIR]` 换成实际路径：

```markdown
## 委派子代理任务

1. 读取 `[SUBAGENT_DIR]/protocol.md`
2. 按任务说明填充任务提示词并派发
3. 按当前环境读取 `[SUBAGENT_DIR]/adapters/` 对应规则；无匹配用 `generic.md`
4. 业务流程不得绕过协议发明工具调用方式
5. 业务判断留在目标 Skill，不写入平台规则
```

## 在业务流程中引用

```markdown
执行 `[TASK_FILE]`。

- 委派规范：`[SUBAGENT_DIR]/protocol.md`
- 是否必须得到结果：[是 / 否]
- 无法派发时：[备用处理方式]
```

多任务时在业务流程写清并行 / 顺序 / 汇总；不要写工具名或平台参数。

## 创建新任务

1. 复制 `task-template.md` 到目标 Skill 的任务目录。  
2. 填：基本信息、上下文方式、任务输入、结果验收、任务提示词。  
3. 在业务流程中引用该文件。  

任务说明不必放进 `subagents/`。

## 增加新 Agent 环境

1. 在 `adapters/` 新增 Markdown。  
2. 按 `protocol.md`「新增适配器应包含」填表。  
3. 只写本环境差异与失败处理；通用规则引用 protocol。  
4. 工具名来自实际工具列表或官方文档；不确定写“不确定/不支持”。  

## 迁移检查

- [ ] 能定位 `protocol.md`  
- [ ] `adapters/` 相对位置未变  
- [ ] 至少有一个具体任务说明，且无平台工具名  
- [ ] 有匹配适配器或允许 `generic.md`  
- [ ] 依赖文件可访问或允许完整内联  
- [ ] 结果验收足够明确  
- [ ] 多任务时业务流程已写关系
