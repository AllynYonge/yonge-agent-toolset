#!/usr/bin/env python3
"""Regression tests for guardrail resolution and workflow wiring.

Run: python3 /absolute/path/to/tests/test_compliance_guardrails.py
These tests do not certify an LLM's semantic review or platform compliance.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SKILL_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL_ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from resolve_preferences import (  # noqa: E402
    ConfigError,
    LENGTH_PRESETS,
    build_profile_result,
    extract_accounts,
    parse_simple_yaml,
    resolve_compliance_guardrails,
    resolve_constraints,
)
from check_prose import (  # noqa: E402
    build_report,
    strip_source_block,
    visible_char_count,
)


class GuardrailResolutionTests(unittest.TestCase):
    def profile(self, config, name=None):
        return build_profile_result(
            str(SKILL_ROOT), None, name, config, str(SKILL_ROOT)
        )

    def run_resolver(self, yaml=None, profile=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / 'workspace'
            workspace.mkdir()
            home = root / 'home'
            home.mkdir()
            if yaml is not None:
                config_dir = workspace / '.human-writing'
                config_dir.mkdir()
                (config_dir / 'EXTEND.md').write_text(
                    '---\n' + yaml + '\n---\n', encoding='utf-8'
                )
            args = [
                sys.executable, '-B', str(SCRIPTS / 'resolve_preferences.py'),
                '--workspace-dir', str(workspace), '--skill-root', str(SKILL_ROOT),
            ]
            if profile:
                args.extend(['--profile', profile])
            env = dict(os.environ, HOME=str(home), PYTHONDONTWRITEBYTECODE='1')
            return subprocess.run(args, capture_output=True, text=True, env=env, check=False)

    def test_absent_rules_preserve_defaults(self):
        result = self.run_resolver()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        profile = data['profiles']['__default__']
        self.assertEqual(profile['compliance_guardrails'], [])
        self.assertEqual(profile['length'], 'auto')
        self.assertEqual(data['config_scope'], 'default')
        self.assertEqual(data['available_profiles'], [])

    def test_account_replaces_global_and_style(self):
        data = {
            'compliance_guardrails': ['global'],
            'demo': {
                'compliance_guardrails': ['account'],
                'custom_style': {'name': 'custom', 'compliance_guardrails': ['style']},
            },
        }
        self.assertEqual(self.profile(data, 'demo')['compliance_guardrails'], ['account'])

    def test_global_precedes_selected_style(self):
        data = {
            'compliance_guardrails': ['global'],
            'demo': {'custom_style': {'compliance_guardrails': ['style']}},
        }
        self.assertEqual(self.profile(data, 'demo')['compliance_guardrails'], ['global'])

    def test_missing_account_field_inherits_global(self):
        data = {'compliance_guardrails': ['global'], 'demo': {'platform': 'wechat'}}
        self.assertEqual(self.profile(data, 'demo')['compliance_guardrails'], ['global'])

    def test_custom_style_fallback(self):
        data = {'demo': {'custom_style': {'compliance_guardrails': ['style']}}}
        self.assertEqual(self.profile(data, 'demo')['compliance_guardrails'], ['style'])

    def test_custom_style_without_rules_yields_empty_list(self):
        result = self.profile({'custom_style': {'name': 'custom'}})
        self.assertEqual(result['style_source'], 'custom_style')
        self.assertEqual(result['compliance_guardrails'], [])

    def test_empty_list_stops_fallback_at_each_level(self):
        configs = [
            {'compliance_guardrails': ['global'], 'demo': {
                'compliance_guardrails': [],
                'custom_style': {'compliance_guardrails': ['style']},
            }},
            {'compliance_guardrails': [], 'demo': {
                'custom_style': {'compliance_guardrails': ['style']},
            }},
            {'demo': {'custom_style': {'compliance_guardrails': []}}},
        ]
        for data in configs:
            with self.subTest(data=data):
                self.assertEqual(self.profile(data, 'demo')['compliance_guardrails'], [])

    def test_rules_remain_strings_in_order_not_avoid_words(self):
        rules = ['  不承诺投资收益  ', '引用来源必须真实', '不承诺投资收益']
        data = {'demo': {
            'compliance_guardrails': rules,
            'custom_style': {'name': 'custom', 'words_to_avoid': '赋能|助力'},
            'avoid_words': ['绝对安全'], 'length': '800-1500',
        }}
        result = self.profile(data, 'demo')
        self.assertEqual(result['compliance_guardrails'],
                         ['不承诺投资收益', '引用来源必须真实', '不承诺投资收益'])
        self.assertEqual(rules[0], '  不承诺投资收益  ')
        self.assertEqual(result['avoid_words'], ['赋能', '助力', '绝对安全'])
        self.assertEqual(result['length'], '800-1500')
        self.assertEqual(result['constraint_check_args'], '--profile demo')

    def test_invalid_selected_values_raise(self):
        invalid = [None, '', 'auto', 'null', '~', 'no claims', False, 3,
                   {}, {'rule': 'text'}, [''], ['  '], [False], [3], [{}], [[]]]
        for value in invalid:
            for location in ('effective', 'style'):
                with self.subTest(value=value, location=location):
                    effective = {'compliance_guardrails': value} if location == 'effective' else {}
                    style = {'compliance_guardrails': value} if location == 'style' else {}
                    with self.assertRaisesRegex(ConfigError, 'compliance_guardrails'):
                        resolve_compliance_guardrails(effective, style)

    def test_invalid_global_dict_is_not_account(self):
        data = {'compliance_guardrails': {'bad': 'shape'}, 'demo': {'platform': 'wechat'}}
        self.assertEqual(list(extract_accounts(data)), ['demo'])
        with self.assertRaisesRegex(ConfigError, 'must be a list'):
            self.profile(data, 'demo')

    def test_multiline_yaml_comments_punctuation_and_nested_fallback(self):
        result = self.run_resolver('''default_profile: demo
demo:
  custom_style:
    name: "日常记录"
    compliance_guardrails:
      - "来源: 不得编造 #1；保留 A|B 的条件。" # 说明
      - "不得声称普通食品可以替代药物。"
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)['profiles']['demo']
        self.assertEqual(profile['compliance_guardrails'], [
            '来源: 不得编造 #1；保留 A|B 的条件。', '不得声称普通食品可以替代药物。',
        ])

    def test_cli_rejects_malformed_rules_with_error_exit(self):
        for value in ('null', '~', 'auto', 'false', '42', '""', '', '|', '>'):
            with self.subTest(value=value):
                result = self.run_resolver('compliance_guardrails: ' + value)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('compliance_guardrails', result.stderr)
                self.assertEqual(result.stdout, '')
        result = self.run_resolver('''demo:
  compliance_guardrails:
    - rule: "mapping not string"
''', 'demo')
        self.assertEqual(result.returncode, 2)
        self.assertIn('compliance_guardrails[1]', result.stderr)

    def test_multi_profile_rules_do_not_leak(self):
        result = self.run_resolver('''compliance_guardrails:
  - "公共规则"
a:
  compliance_guardrails:
    - "账号 A 规则"
b:
  compliance_guardrails: []
c:
  platform: wechat
''', 'a|b|c')
        self.assertEqual(result.returncode, 0, result.stderr)
        profiles = json.loads(result.stdout)['profiles']
        self.assertEqual(profiles['a']['compliance_guardrails'], ['账号 A 规则'])
        self.assertEqual(profiles['b']['compliance_guardrails'], [])
        self.assertEqual(profiles['c']['compliance_guardrails'], ['公共规则'])

    def test_existing_profile_without_field_is_unchanged(self):
        data = parse_simple_yaml('''demo:
  platform: wechat
  medium: article
  length: "800-1500"
  output_dir: articles
  custom_style:
    name: "原有风格"
    stance: "平实"
    words_to_avoid: "赋能|助力"
''')
        result = self.profile(data, 'demo')
        self.assertEqual(result['effective_config'], {**data['demo'], '_active_profile': 'demo'})
        self.assertEqual(result['style'], data['demo']['custom_style'])
        self.assertEqual(result['compliance_guardrails'], [])
        self.assertEqual(result['output_dir'], str(SKILL_ROOT / 'articles'))

    def test_word_check_does_not_claim_semantic_review(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'EXTEND.md'
            path.write_text('''---
demo:
  length: auto
  custom_style:
    name: "简洁"
    words_to_avoid: "违禁样例词"
  compliance_guardrails:
    - "不得承诺投资收益。"
---
''', encoding='utf-8')
            constraints = resolve_constraints(str(path), 'demo', None)
            # Semantic violation with no literal avoid-word hit: script alone must not be
            # mistaken for a compliance verdict. A reviewer still has to apply the rules.
            report = build_report('这项投资保证本金翻倍。', constraints)
            self.assertTrue(report['pass'])
            self.assertNotIn('compliance_guardrails', report)
            self.assertFalse(build_report('违禁样例词', constraints)['pass'])


class WorkflowWiringTests(unittest.TestCase):
    def text(self, relative):
        return (SKILL_ROOT / relative).read_text(encoding='utf-8')

    def test_workflow_and_standalone_review_supply_rules(self):
        for relative in ('SKILL.md', 'agents/reviewer.md'):
            with self.subTest(path=relative):
                text = self.text(relative)
                self.assertIn('compliance_guardrails', text)
                self.assertIn('[]', text)
        self.assertIn('agents/reviewer.md', self.text('SKILL.md'))

    def test_review_prompt_contains_full_contract(self):
        text = self.text('agents/reviewer.md')
        prompt = text.split('```prompt\n', 1)[1].rsplit('```', 1)[0]
        self.assertIn('[COMPLIANCE_GUARDRAILS]', prompt)
        self.assertIn('#### 合规红线检查', prompt)
        self.assertIn('原文位置与引用 / 核实缺口', prompt)
        self.assertIn('违反和待核实均阻止 PASS', prompt)
        self.assertIn('输入或依赖缺失时使用 ERROR', prompt)
        self.assertIn('不得标记为可发布', text)

    def test_skill_explains_semantic_check_and_conflict_handling(self):
        text = self.text('references/publish/overview.md')
        self.assertIn('length` / 规避词检查不能代替合规审核', text)
        self.assertIn('含短任务、各 `deep` 档位', text)
        self.assertIn('不能因达到迭代上限而放行', text)
        self.assertIn('暂停相关内容并列出待确认项', text)


class MergedCheckerTests(unittest.TestCase):
    def run_checker(self, text, *args):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'draft.md'
            path.write_text(text, encoding='utf-8')
            cmd = [sys.executable, '-B', str(SCRIPTS / 'check_prose.py'), *args, str(path)]
            return subprocess.run(cmd, capture_output=True, text=True, check=False)

    def test_short_preset_matches_schema(self):
        self.assertEqual(LENGTH_PRESETS['short'], (300, 500))

    def test_over_upper_fails_under_lower_warns(self):
        constraints = {'length': '5-8', 'avoid_words': [], 'style_source': 'x',
                       'effective_config': {}}
        over = build_report('一二三四五六七八九十', constraints)
        self.assertFalse(over['pass'])
        self.assertEqual(over['length']['status'], 'fail')
        under = build_report('一二三', constraints)
        self.assertTrue(under['pass'])
        self.assertEqual(under['length']['status'], 'under')
        self.assertEqual(under['warnings'][0]['type'], 'length')

    def test_length_counts_all_non_whitespace(self):
        self.assertEqual(visible_char_count('ab 中文\n，。'), 6)

    def test_source_block_is_excluded_from_length(self):
        constraints = {'length': '5-8', 'avoid_words': [], 'style_source': 'x',
                       'effective_config': {}}
        body = '一二三四五六\n'
        tail = '\n---\n\n参考来源\n\n- 甲乙丙丁戊己庚辛壬癸 https://example.com\n'
        with_tail = build_report(body + tail, constraints)
        self.assertEqual(with_tail['length']['visible_char_count'], 9)
        self.assertEqual(with_tail['length']['status'], 'fail')
        self.assertGreater(with_tail['length']['source_block_chars'], 0)
        self.assertEqual(visible_char_count(strip_source_block(body + tail)),
                         visible_char_count(body + '---'))
        # 带 # 前缀的标题同样识别
        hashed = strip_source_block(body + '\n## 参考来源\n- 甲\n')
        self.assertNotIn('甲', hashed)
        # 没有来源区时统计不变
        plain = build_report(body, constraints)
        self.assertEqual(plain['length']['visible_char_count'], 6)
        self.assertEqual(plain['length']['source_block_chars'], 0)
        # 正文里提到“参考来源”但不是独立标题行时，不截断
        inline = '参考来源很重要，这句在正文里。'
        self.assertEqual(strip_source_block(inline), inline)

    def test_plain_run_reads_no_config(self):
        result = self.run_checker('他把表格改了一遍，第二天交给了组长。\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('篇幅', result.stdout)

    def test_constraint_args_merge_into_one_exit_code(self):
        result = self.run_checker('他把表格改了一遍，第二天交给了组长。\n', '--length', '5')
        self.assertEqual(result.returncode, 1)
        self.assertIn('超过目标上限', result.stdout)
        with tempfile.TemporaryDirectory() as folder:
            extend = Path(folder) / 'EXTEND.md'
            extend.write_text('---\navoid_words: [表格]\n---\n', encoding='utf-8')
            result = self.run_checker('他把表格改了一遍。\n', '--extend', str(extend), '--json')
            data = json.loads(result.stdout)
            self.assertFalse(data['pass'])
            self.assertEqual(data['constraints']['avoid_words']['hit_count'], 1)

    def test_platform_labels_only_release_label_colons(self):
        text = '📍地址：上海徐汇\n- ⏰营业：十点开门\n提示：这里不行\n'
        plain = self.run_checker(text)
        self.assertIn('中文冒号共 3 处', plain.stdout)
        labelled = self.run_checker(text, '--platform-labels')
        self.assertIn('中文冒号共 1 处', labelled.stdout)
        self.assertEqual(labelled.returncode, 1)


class FlowTests(unittest.TestCase):
    """flow has been removed; verify it is not present in config, schema, or skill docs."""

    def text(self, relative):
        return (SKILL_ROOT / relative).read_text(encoding='utf-8')

    def test_resolver_does_not_return_flow(self):
        result = build_profile_result(str(SKILL_ROOT), None, 'demo',
                                      {'flow': 'detail', 'demo': {'flow': 'detail'}},
                                      str(SKILL_ROOT))
        self.assertNotIn('flow', result)

    def test_schema_has_no_flow_field(self):
        text = self.text('references/publish/config/extend-schema.md')
        self.assertNotIn('### flow', text)
        self.assertNotIn('| `flow` |', text)

    def test_skill_does_not_use_flow_flags_or_dual_flow(self):
        text = self.text('SKILL.md')
        self.assertNotIn('--flow', text)
        self.assertNotIn('## 交互流程 simple 与 detail', text)
        for old in ('`--simple`', '`--detail`', 'simple 流程', 'detail 流程'):
            self.assertNotIn(old, text)

    def test_no_file_points_flow_rules_to_overview(self):
        for path in SKILL_ROOT.rglob('*.md'):
            if 'dist' in path.parts:
                continue
            with self.subTest(path=str(path.relative_to(SKILL_ROOT))):
                text = path.read_text(encoding='utf-8')
                self.assertNotIn('overview.md「交互流程', text)
                self.assertNotIn('overview.md`「交互流程', text)
                self.assertNotIn('`--simple`', text)
                self.assertNotIn('`--detail`', text)
                self.assertNotIn('--flow', text)


class UnifiedFlowTests(unittest.TestCase):
    """There is one workflow; platform, profile and style are capabilities, not a route."""

    def test_no_style_configured_applies_no_preset(self):
        result = build_profile_result(str(SKILL_ROOT), None, None, {}, str(SKILL_ROOT))
        self.assertIsNone(result['style_source'])
        self.assertEqual(result['style'], {})
        self.assertEqual(result['avoid_words'], [])
        constraints = resolve_constraints(None, None, None)
        self.assertIsNone(constraints['style_source'])
        self.assertEqual(constraints['avoid_words'], [])

    def test_removed_writing_style_is_rejected(self):
        # 内置预设已取消：遗留的 writing_style 必须报错，不能被静默忽略。
        with self.assertRaises(ConfigError):
            build_profile_result(str(SKILL_ROOT), None, None,
                                 {'writing_style': 'warm-narrative'}, str(SKILL_ROOT))
        with self.assertRaises(ConfigError):
            build_profile_result(str(SKILL_ROOT), None, 'demo',
                                 {'demo': {'writing_style': 'warm-narrative',
                                           'custom_style': {'name': 'x'}}},
                                 str(SKILL_ROOT))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'EXTEND.md'
            path.write_text('---\ndemo:\n  writing_style: lucid-tech\n---\n', encoding='utf-8')
            with self.assertRaises(ConfigError):
                resolve_constraints(str(path), 'demo', None)

    def test_styles_directory_is_gone(self):
        self.assertFalse((SKILL_ROOT / 'references' / 'publish' / 'styles').exists())

    def test_no_route_concept_left(self):
        paths = [SKILL_ROOT / 'SKILL.md', *SKILL_ROOT.glob('references/**/*.md'),
                 *SKILL_ROOT.glob('agents/*.md'), *SKILL_ROOT.glob('scripts/*.py'),
                 *SKILL_ROOT.glob('tests/*.py')]
        for path in paths:
            if path.name == Path(__file__).name:
                continue
            with self.subTest(path=str(path.relative_to(SKILL_ROOT))):
                text = path.read_text(encoding='utf-8')
                self.assertNotIn('自媒体路线', text)
                self.assertNotIn('本路线', text)

    def test_single_workflow_lives_in_skill(self):
        text = (SKILL_ROOT / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('### 九步流程', text)
        self.assertIn('references/tasks/rewrite.md', text)
        self.assertNotIn('workflows/', text)
        self.assertFalse((SKILL_ROOT / 'references' / 'publish' / 'workflows').exists())


class ReferenceIntegrityTests(unittest.TestCase):
    """Every path a document points to must exist."""

    PATH_RE = re.compile(r'`((?:references|agents|scripts|tests|dist)/[A-Za-z0-9_./-]+\.(?:md|py|yaml))`')
    LINK_RE = re.compile(r'\]\(([^)#:]+\.md)')

    def test_referenced_paths_exist(self):
        for path in SKILL_ROOT.rglob('*.md'):
            text = path.read_text(encoding='utf-8')
            for target in self.PATH_RE.findall(text):
                with self.subTest(source=str(path.relative_to(SKILL_ROOT)), target=target):
                    self.assertTrue((SKILL_ROOT / target).exists())
            for target in self.LINK_RE.findall(text):
                with self.subTest(source=str(path.relative_to(SKILL_ROOT)), link=target):
                    self.assertTrue((path.parent / target).exists())

    def test_resolver_command_written_once(self):
        hits = [p for p in SKILL_ROOT.rglob('*.md')
                if 'python3 scripts/resolve_preferences.py' in p.read_text(encoding='utf-8')]
        self.assertEqual([p.relative_to(SKILL_ROOT).as_posix() for p in hits], ['SKILL.md'])


class RuleCodeTests(unittest.TestCase):
    """Checker output points straight to the matching revision.md section."""

    def run_json(self, text, *args):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'draft.md'
            path.write_text(text, encoding='utf-8')
            cmd = [sys.executable, '-B', str(SCRIPTS / 'check_prose.py'), *args, '--json', str(path)]
            result = subprocess.run(cmd, capture_output=True, text=True, check=False)
            return json.loads(result.stdout)

    def test_every_code_has_a_revision_section(self):
        from check_prose import RULE_NAMES
        text = (SKILL_ROOT / 'references' / 'quality' / 'revision.md').read_text(encoding='utf-8')
        for code, name in RULE_NAMES.items():
            with self.subTest(code=code):
                self.assertIn(f'### {code} {name}\n', text)

    def test_issues_carry_codes(self):
        with tempfile.TemporaryDirectory() as folder:
            extend = Path(folder) / 'EXTEND.md'
            extend.write_text('---\navoid_words: [搜索]\n---\n', encoding='utf-8')
            data = self.run_json('他说白了就是想赋能。\n真正决定我留下来的不是速度，而是搜索。\n',
                                 '--extend', str(extend))
        codes = {issue['code'] for issue in data['issues'] if issue['level'] == 'fail'}
        self.assertTrue({'S2', 'C2'} <= codes)
        self.assertTrue(all(item.startswith('[') for item in data['failures']))
        self.assertEqual(len(data['failures']) + len(data['warnings']), len(data['issues']))


class SingleSourceTests(unittest.TestCase):
    """A drafting example lives in one craft file; revision.md may reuse it only as a before/after pair."""

    SAMPLES = (
        '天将明，人未归',
        '他从抽屉里翻出一张收据',
        '他关掉一条好走的路',
        '会后悔，而且通常不是买错那一下就后悔',
    )

    def test_samples_written_once_in_craft_and_skill(self):
        paths = [SKILL_ROOT / 'SKILL.md', *SKILL_ROOT.glob('references/craft/*.md')]
        for sample in self.SAMPLES:
            hits = [p.name for p in paths if sample in p.read_text(encoding='utf-8')]
            with self.subTest(sample=sample):
                self.assertEqual(len(hits), 1, hits)

    def test_skill_routes_reading_by_two_questions(self):
        text = (SKILL_ROOT / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('### 起草时读哪些文件', text)
        self.assertNotIn('craft/voice.md', text)
        self.assertFalse((SKILL_ROOT / 'references' / 'craft' / 'voice.md').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
