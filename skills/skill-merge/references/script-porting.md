# 脚本移植指南

将源技能的脚本能力移植到目标技能时的注意事项和模式。

---

## 原则：重写优于复制

**永远不要直接复制源技能的脚本。** 原因：

1. 技术栈可能不同（Python → Node.js，CJS → ESM）
2. 代码风格必须匹配目标技能
3. 依赖管理必须统一
4. 接口约定（输入/输出格式）必须一致

正确做法：理解源脚本的**功能意图**，用目标技能的技术栈和风格**重新实现**。

---

## 移植前检查清单

| 检查项 | 确认内容 |
|--------|---------|
| 目标技能用什么语言？ | Node.js (ESM .mjs) / Python / Shell / 其他 |
| 目标技能的脚本如何被调用？ | CLI 直接调用 / 被其他脚本 import / 被 SKILL.md 引用 |
| 目标技能的输出格式？ | JSON to stdout / 文件写入 / 两者兼有 |
| 目标技能有外部依赖吗？ | 纯 built-in / 有 package.json / 有 requirements.txt |
| 源脚本的核心算法是什么？ | BM25 / 模板渲染 / 解析器 / 生成器 / 其他 |

---

## 风格匹配模式

### Node.js (ESM) 风格匹配

读取目标技能的现有脚本，提取以下模式并严格遵循：

```javascript
// 1. 导入风格
import fs from 'node:fs';        // 使用 node: 前缀
import path from 'node:path';

// 2. 路径解析
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

// 3. 导出模式
export function publicFunction() { ... }

// 4. CLI 入口模式
const _running = process.argv[1];
if (_running?.endsWith('script-name.mjs') || _running?.endsWith('script-name.mjs/')) {
  run();
}

// 5. 输出格式
console.log(JSON.stringify(result, null, 2));

// 6. 错误处理
console.error('Error message');
process.exit(1);
```

### Python 风格匹配

```python
# 1. 导入风格 — 匹配源技能的分组习惯
import sys
import csv
from pathlib import Path

# 2. CLI 入口
if __name__ == '__main__':
    main()

# 3. 输出格式
import json
print(json.dumps(result, indent=2, ensure_ascii=False))
```

---

## 常见移植场景

### 场景 1：搜索引擎移植（Python BM25 → Node.js）

**源（Python）：**
- CSV 加载 + pandas/csv 解析
- BM25 算法（k1, b 参数）
- argparse CLI

**目标（Node.js）：**
- `fs.readFileSync` + 手写 CSV parser（避免引入依赖）
- 相同 BM25 算法（保持 k1=1.5, b=0.75）
- `process.argv` 手动解析

**验证：** 用相同 query 对比两版输出的 top-3 结果，允许 ±1 位排序偏差（浮点精度差异）。

### 场景 2：模板渲染移植

**源：** Jinja2 / Handlebars / 字符串拼接
**目标：** 匹配目标技能已有的模板方式

如果目标技能没有模板引擎，用 template literal 拼接：
```javascript
function render(tokens) {
  return `<!DOCTYPE html>
<html>
<head><title>${tokens.name}</title></head>
...`;
}
```

### 场景 3：配置/规则文档移植

**源：** 中文 Markdown / YAML / JSON
**目标：** 匹配目标技能的文档语言和格式

- 目标技能是英文 → 翻译规则内容为英文
- 目标技能用 Markdown 表格 → 转换为表格格式
- 保留语义，不保留原始格式

---

## 依赖管理规则

| 情况 | 处理方式 |
|------|---------|
| 目标技能无 package.json | 只用 Node.js built-in（fs, path, url, crypto） |
| 目标技能有 package.json | 可以使用已有依赖，不新增 |
| 源脚本依赖第三方库 | 用 built-in 重新实现核心逻辑 |
| 算法复杂度高（如 ML） | 与用户确认是否可以引入依赖 |

**黄金规则：** 新增脚本的依赖集 ⊆ 目标技能现有依赖集。

---

## 接口设计规范

新增脚本的 CLI 接口应遵循：

```
node extensions/scripts/<name>.mjs <positional_args> [--flag value] [--boolean-flag]
```

**输出约定：**
- 成功：JSON to stdout（`console.log(JSON.stringify(...))`）
- 错误：文本 to stderr（`console.error(...)`）+ `process.exit(1)`
- 进度：不输出（脚本应快速完成，不需要进度条）

**参数约定：**
- 位置参数：查询字符串或主要输入
- `--flag value`：配置选项
- `--boolean-flag`：开关（无值）
- 所有参数可选时提供合理默认值

---

## 测试移植结果

每个移植的脚本必须通过：

1. **独立运行测试** — 脚本可以单独执行，不依赖其他新增脚本
2. **输出格式测试** — 输出是合法 JSON（或预期格式）
3. **边界测试** — 空输入、不存在的文件、无匹配结果
4. **回归测试** — 目标技能的现有脚本行为不变

```bash
# 示例验证命令
node extensions/scripts/search-data.mjs "test query" --domain color --json
# 应返回合法 JSON，resultCount >= 0

node scripts/load-context.mjs
# 现有脚本应正常工作，输出不变
```
