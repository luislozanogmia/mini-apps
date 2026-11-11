"""Portable source checks; no external services, GPU, or desktop automation."""
from pathlib import Path
import ast
import json
import subprocess
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[1]

def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)

files = [p for p in ROOT.rglob('*') if p.is_file() and not any(
    x in p.relative_to(ROOT).parts for x in ('.git', 'node_modules', 'output', '__pycache__', '.venv'))]
for p in files:
    if p.suffix == '.py':
        ast.parse(p.read_text(), filename=str(p.relative_to(ROOT)))
    elif p.suffix in ('.js', '.cjs'):
        run('node', '--check', str(p))
    elif p.suffix == '.json':
        json.loads(p.read_text())
run('npm', 'test', cwd=ROOT / 'apps/slop-filter')
run('node', '--test', 'tests/local-access.test.cjs', cwd=ROOT / 'apps/galaxy')

# ContextRAG's extraction -> snippetization -> evidence composition stays offline.
with tempfile.TemporaryDirectory(prefix='mini-apps-check-') as directory:
    tmp = Path(directory)
    (tmp / 'source.html').write_text('<html><body><h1>Example observatory</h1><p>The telescope mirror diameter is 6.5 meters. The telescope mirror was installed in 2021. The telescope mirror consists of 18 segments.</p></body></html>')
    cli = str(ROOT / 'harness/contextrag/contextrag.py')
    run(sys.executable, cli, 'extract', '--from-file', str(tmp / 'source.html'), '--to-file', str(tmp / 'extracted.txt'), cwd=tmp)
    run(sys.executable, cli, 'snippetize', '--from-file', str(tmp / 'extracted.txt'), '--source-url', 'https://example.com/observatory', '--to-file', str(tmp / 'evidence.jsonl'), cwd=tmp)
    run(sys.executable, cli, 'compose', 'telescope mirror diameter', '--files', str(tmp / 'evidence.jsonl'), '--out', str(tmp / 'prompt.txt'), cwd=tmp)
    prompt = (tmp / 'prompt.txt').read_text()
    assert '6.5' in prompt and 'example.com' in prompt, 'Evidence must preserve the numeric fact and source'
print('PASS: Python/JS/JSON syntax, Slop Filter rules, Galaxy request boundaries, ContextRAG offline pipeline')
