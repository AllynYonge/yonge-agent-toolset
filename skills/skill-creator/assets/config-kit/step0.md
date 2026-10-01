<!--
  模板：目标技能 SKILL.md 的「步骤 0」。
  复制后替换 {{...}} 占位，删除本注释。
  - {{skill}}：技能名（与配置目录名一致）
  - {{gated_actions}}：需要配置才能执行的操作，如「生成」「发布」
  - {{ungated_actions}}：不需要配置的操作；没有就删掉那一行
  - {{setup_fields}}：首次设置要问的项目
  - {{field_summary}}：EXTEND.md 字段的中文概括，一句话
  - {{secret_vars}}：本技能用到的密钥变量名
-->
## 步骤 0：加载偏好配置 ⛔ 阻断

{{gated_actions}}前必须完成。{{ungated_actions}}不受此限制。

按顺序检查，命中第一个就停，不合并：

| 路径 | 作用域 |
|------|--------|
| `<cwd>/.yonge/.yonge-skills/{{skill}}/EXTEND.md` | 项目 |
| `~/.yonge/.yonge-skills/{{skill}}/EXTEND.md` | 用户 |

- **找到** → 加载并应用。必需字段为空时，只补问该字段。
- **没找到** → 走首次设置（`references/config/first-time-setup.md`），收集 {{setup_fields}}，写入 EXTEND.md 后继续原任务。

**EXTEND.md 字段**：{{field_summary}}。结构见 `references/config/preferences-schema.md`。

**密钥**：{{secret_vars}} 只放 `~/.yonge/.yonge-skills/.env`（项目级 `<cwd>/.yonge/.yonge-skills/.env` 可覆盖），不写进 EXTEND.md。

**优先级**：CLI 参数 > EXTEND.md > 环境变量 > 项目 .env > 用户 .env > 内置默认值
