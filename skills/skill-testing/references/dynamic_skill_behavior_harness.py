#!/usr/bin/env python3
"""Generic dynamic behavior test harness for Hermes skills.

Runs real Hermes CLI turns in an isolated HERMES_HOME, captures stdout and the
created session transcript, then evaluates expectations declared in a JSON spec.
This is intentionally black-box: it tests what an actual Hermes Agent does, not
just what SKILL.md says.
"""
# Canonical maintained copy: references/dynamic_skill_behavior_harness.py
# See SKILL.md for full spec format and workflow.

from __future__ import annotations
import argparse, json, os, re, shutil, subprocess, tempfile, time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

REPO = Path(os.environ.get('HERMES_REPO', os.getcwd()))
DEFAULT_TIMEOUT = 240

@dataclass
class AssertionResult:
    assertion: dict[str, Any]
    passed: bool
    detail: str

@dataclass
class CaseResult:
    id: str
    passed: bool
    turns: list[dict[str, Any]]
    assertions: list[AssertionResult]

def run(cmd, *, env, timeout, cwd=REPO):
    return subprocess.run(cmd, cwd=str(cwd), env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)

def copy_skill_tree(skill_name: str, hermes_home: Path) -> None:
    src_root = Path(os.environ.get('HERMES_HOME', Path.home() / '.hermes')) / 'skills'
    matches = [p for p in src_root.rglob('SKILL.md') if p.parent.name == skill_name]
    if not matches:
        raise FileNotFoundError(f'Skill {skill_name!r} not found under {src_root}')
    rel_dir = matches[0].parent.relative_to(src_root)
    dst = hermes_home / 'skills' / rel_dir
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists(): shutil.rmtree(dst)
    shutil.copytree(matches[0].parent, dst)

def write_config(hermes_home: Path, spec: dict[str, Any]) -> None:
    hermes_home.mkdir(parents=True, exist_ok=True)
    real_home = Path(os.environ.get('HERMES_HOME', Path.home() / '.hermes'))
    if spec.get('inherit_runtime_config', True) and (real_home / 'config.yaml').exists():
        shutil.copy2(real_home / 'config.yaml', hermes_home / 'config.yaml')
        for name in ['.env', 'auth.json']:
            src = real_home / name
            if src.exists(): shutil.copy2(src, hermes_home / name)
        with (hermes_home / 'config.yaml').open('a', encoding='utf-8') as f:
            f.write('\n\n# dynamic-skill-behavior-test overrides\n')
            f.write(f"agent:\n  max_turns: {spec.get('agent_max_turns', 20)}\n")
            f.write('memory:\n  memory_enabled: false\n  user_profile_enabled: false\n')
            f.write('compression:\n  enabled: false\n')
        return
    (hermes_home / 'config.yaml').write_text('agent:\n  max_turns: 20\nmemory:\n  memory_enabled: false\n  user_profile_enabled: false\ncompression:\n  enabled: false\n', encoding='utf-8')

def session_files(home: Path):
    d = home / 'sessions'
    return set(p for p in d.rglob('*') if p.is_file()) if d.exists() else set()

def read_new(before, home):
    chunks = []
    for p in sorted(session_files(home) - before, key=lambda p: p.stat().st_mtime):
        try: chunks.append(f'\n---FILE {p}---\n' + p.read_text(encoding='utf-8', errors='replace'))
        except Exception: pass
    return '\n'.join(chunks)

def tools_in(text):
    out = []
    for pat in [r'"name"\s*:\s*"([A-Za-z0-9_:-]+)"', r'tool(?:_call)?\s*[:=]\s*([A-Za-z0-9_:-]+)', r'Calling tool\s+([A-Za-z0-9_:-]+)']:
        out += re.findall(pat, text)
    return out

def target_text(target, blob):
    return blob.get(target, '') if target != 'all' else '\n'.join(blob.values())

def eval_a(a, blob, tool_names):
    typ, target = a['type'], a.get('target', 'all')
    text = target_text(target, blob)
    if typ == 'contains':
        ok = a['value'] in text; return AssertionResult(a, ok, f"expected {target} to contain {a['value']!r}")
    if typ == 'not_contains':
        ok = a['value'] not in text; return AssertionResult(a, ok, f"expected {target} not to contain {a['value']!r}")
    if typ == 'regex':
        ok = re.search(a['pattern'], text, re.S) is not None; return AssertionResult(a, ok, f"expected {target} to match /{a['pattern']}/s")
    if typ == 'not_regex':
        ok = re.search(a['pattern'], text, re.S) is None; return AssertionResult(a, ok, f"expected {target} not to match /{a['pattern']}/s")
    if typ == 'tool_called':
        ok = a['name'] in tool_names; return AssertionResult(a, ok, f"expected tool {a['name']!r} in {tool_names}")
    if typ == 'tool_not_called':
        ok = a['name'] not in tool_names; return AssertionResult(a, ok, f"expected tool {a['name']!r} not in {tool_names}")
    if typ == 'exit_code':
        actual = int(blob.get('exit_code', '999999')); ok = actual == int(a['value']); return AssertionResult(a, ok, f"expected exit_code={a['value']}, got {actual}")
    raise ValueError(f'unknown assertion type {typ!r}')

def run_case(spec, case, env, home):
    session_id = None; turns = []; exit_codes = []
    blob = {'stdout':'','stderr':'','transcript':'','exit_code':'0','exit_codes':''}
    before = session_files(home)
    for idx, prompt in enumerate(case['turns']):
        cmd = ['hermes','chat','-q',prompt,'--quiet','--source','skill-behavior-test','--max-turns',str(case.get('max_turns', spec.get('agent_max_turns',20)))]
        if spec.get('preload_skill', True) and idx == 0: cmd += ['--skills', spec['skill']]
        if spec.get('toolsets'): cmd += ['--toolsets', str(spec['toolsets'])]
        if spec.get('model'): cmd += ['--model', str(spec['model'])]
        if spec.get('provider'): cmd += ['--provider', str(spec['provider'])]
        if session_id: cmd += ['--resume', session_id]
        try:
            cp = run(cmd, env=env, timeout=int(case.get('timeout', spec.get('timeout', DEFAULT_TIMEOUT))))
        except subprocess.TimeoutExpired as e:
            turns.append({'prompt':prompt,'cmd':cmd,'exit_code':-1,'stdout':e.stdout or '','stderr':e.stderr or '','error':'timeout'})
            exit_codes.append(-1)
            blob['stdout'] += f"\n---TURN {idx+1} STDOUT---\n{e.stdout or ''}"
            blob['stderr'] += f"\n---TURN {idx+1} STDERR---\n[TIMEOUT] Process exceeded {case.get('timeout', spec.get('timeout', DEFAULT_TIMEOUT))}s"
            blob['exit_code'] = '-1'
            break
        m = re.search(r'Session(?: ID)?:\s*([A-Za-z0-9_.:-]+)', (cp.stdout or '') + '\n' + (cp.stderr or ''))
        if m: session_id = m.group(1)
        turns.append({'prompt':prompt,'cmd':cmd,'exit_code':cp.returncode,'stdout':cp.stdout or '', 'stderr':cp.stderr or ''})
        exit_codes.append(cp.returncode)
        blob['stdout'] += f"\n---TURN {idx+1} STDOUT---\n{cp.stdout or ''}"
        blob['stderr'] += f"\n---TURN {idx+1} STDERR---\n{cp.stderr or ''}"
        blob['exit_code'] = str(cp.returncode)
    blob['exit_codes'] = ','.join(str(c) for c in exit_codes)
    blob['transcript'] = read_new(before, home)
    names = tools_in('\n'.join(blob.values()))
    assertions = [eval_a(a, blob, names) for a in case.get('assertions', [])]
    # Only use implicit exit_code==0 check if no explicit exit_code assertion exists
    has_exit_code_assertion = any(a['type'] == 'exit_code' for a in case.get('assertions', []))
    if has_exit_code_assertion:
        passed = all(a.passed for a in assertions)
    else:
        passed = all(a.passed for a in assertions) and all(c == 0 for c in exit_codes)
    return CaseResult(case.get('id','unnamed'), passed, turns, assertions)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('spec', type=Path); ap.add_argument('--out', type=Path); ap.add_argument('--keep-home', action='store_true'); args = ap.parse_args()
    spec = json.loads(args.spec.read_text(encoding='utf-8'))
    home = Path(tempfile.mkdtemp(prefix='hermes-skill-behavior-'))
    env = os.environ.copy(); env['HERMES_HOME'] = str(home); env['HERMES_ACCEPT_HOOKS'] = '1'
    write_config(home, spec); copy_skill_tree(spec['skill'], home)
    for n in spec.get('related_skills', []): copy_skill_tree(n, home)
    started = time.time(); results = [run_case(spec, c, env, home) for c in spec.get('cases', [])]
    report = {'skill': spec['skill'], 'success': all(c.passed for c in results), 'passed': sum(c.passed for c in results), 'failed': sum(not c.passed for c in results), 'total': len(results), 'duration_seconds': round(time.time()-started,2), 'hermes_home': str(home), 'cases': [{'id':c.id,'passed':c.passed,'turns':c.turns,'assertions':[asdict(a) for a in c.assertions]} for c in results]}
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out: args.out.write_text(text, encoding='utf-8')
    print(text)
    if not args.keep_home: shutil.rmtree(home, ignore_errors=True)
    return 0 if report['success'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
