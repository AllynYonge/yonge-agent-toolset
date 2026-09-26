#!/usr/bin/env python3
"""Regression tests for guardrail resolution and workflow wiring.

Run: python3 /absolute/path/to/scripts/test_compliance_guardrails.py
These tests do not certify an LLM's semantic review or platform compliance.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

from check_article_constraints import (  # noqa: E402
    ConfigError,
    build_report,
    parse_simple_yaml,
    resolve_constraints,
)
from resolve_preferences import (  # noqa: E402
    build_profile_result,
    extract_accounts,
    resolve_compliance_guardrails,
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
                config_dir = workspace / '.human-media-writer'
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

    def test_selected_preset_supplies_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            styles = root / 'references' / 'styles'
            styles.mkdir(parents=True)
            (styles / 'demo.md').write_text('''---
name: demo
compliance_guardrails:
  - "预设规则"
---
''', encoding='utf-8')
            result = build_profile_result(str(root), None, None,
                                          {'writing_style': 'demo'}, str(root))
            self.assertEqual(result['compliance_guardrails'], ['预设规则'])

    def test_custom_style_does_not_mix_in_preset_rules(self):
        # A custom style replaces the preset entirely, even with no extra rules.
        result = self.profile({'custom_style': {'name': 'custom'},
                               'writing_style': 'nonexistent-preset'})
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
            constraints = resolve_constraints(str(SKILL_ROOT), str(path), 'demo', None, None, [])
            # Semantic violation with no literal avoid-word hit: script alone must not be
            # mistaken for a compliance verdict. A reviewer still has to apply the rules.
            report = build_report('这项投资保证本金翻倍。', constraints)
            self.assertTrue(report['pass'])
            self.assertNotIn('compliance_guardrails', report)
            self.assertFalse(build_report('违禁样例词', constraints)['pass'])


class WorkflowWiringTests(unittest.TestCase):
    def text(self, relative):
        return (SKILL_ROOT / relative).read_text(encoding='utf-8')

    def test_craft_rewrite_and_standalone_review_supply_rules(self):
        for name in ('craft', 'rewrite', 'review'):
            with self.subTest(name=name):
                text = self.text(f'references/workflows/{name}.md')
                self.assertIn('compliance_guardrails', text)
                self.assertIn('[]', text)
                self.assertIn('agents/article-review.md', text)

    def test_review_prompt_contains_full_contract(self):
        text = self.text('agents/article-review.md')
        prompt = text.split('```prompt\n', 1)[1].rsplit('```', 1)[0]
        self.assertIn('[COMPLIANCE_GUARDRAILS]', prompt)
        self.assertIn('#### 合规红线检查', prompt)
        self.assertIn('原文位置与引用 / 核实缺口', prompt)
        self.assertIn('违反和待核实均阻止 PASS', prompt)
        self.assertIn('输入或依赖缺失时使用 ERROR', prompt)
        self.assertIn('不得标记为可发布', text)

    def test_skill_explains_semantic_check_and_conflict_handling(self):
        text = self.text('SKILL.md')
        self.assertIn('length` / 规避词检查不能代替合规审核', text)
        self.assertIn('含短任务、各 `deep` 档位', text)
        self.assertIn('不能因达到迭代上限而放行', text)
        self.assertIn('暂停相关内容并列出待确认项', text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
