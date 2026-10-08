"""Summarise docs/evidence/loadtest/raw/*.txt (output of RAW_OUT=... loadtest/run-local.sh) into a table.
Reads only what the raw files contain; computes median and range per configuration. Usage: python scripts/evidence/summarize-load.py [raw_dir]"""
import json, re, statistics, sys
from collections import defaultdict
from pathlib import Path

raw = Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/evidence/loadtest/raw')
unit = lambda v, u: float(v) * {'µs': 0.001, 'ms': 1, 's': 1000}[u]

def parse(path: Path):
    t = path.read_text(encoding='utf-8', errors='replace')
    r = {}
    m = re.search(r'notifications_accepted\.+:\s+(\d+)', t); r['accepted'] = int(m.group(1)) if m else None
    m = re.search(r'\{ scenario:send \}\.+: .*?p\(95\)=([\d.]+)(µs|ms|s)', t); r['p95_ms'] = unit(*m.groups()) if m else None
    m = re.search(r'http_req_failed\.+:\s+([\d.]+)%', t); r['http_failed_pct'] = float(m.group(1)) if m else None
    m = re.search(r'dropped_iterations\.+:\s+(\d+)', t); r['dropped'] = int(m.group(1)) if m else 0
    m = re.search(r'msg="(\{.*?\})" source=console', t)
    if m:
        j = json.loads(m.group(1).replace('\\"', '"'))
        r.update(e2e_seconds=j['seconds'], e2e_per_min=j['end_to_end_per_minute'], still_in_flight=j['still_in_flight'])
    for status in ('delivered', 'failed', 'queued', 'sending', 'suppressed', 'batched'):
        m = re.search(rf'^notifications {status} (\d+)', t, re.M); r[f'db_{status}'] = int(m.group(1)) if m else 0
    stats = Path(str(path) + '.stats')
    for who in ('app', 'k6'):
        cpus = [float(x) for x in re.findall(rf'ns-load-{who} cpu=([\d.]+)%', stats.read_text()) ] if stats.exists() else []
        r[f'{who}_cpu_max'] = max(cpus) if cpus else None
    return r

groups = defaultdict(list)
for p in sorted(raw.glob('*.txt')):
    if p.name == 'status.txt': continue
    name = re.sub(r'-run\d+$', '', p.stem)
    groups[name].append((p.stem, parse(p)))

def med(vals): vals = [v for v in vals if v is not None]; return statistics.median(vals) if vals else None
def rng(vals): vals = [v for v in vals if v is not None]; return f'{min(vals):g}-{max(vals):g}' if vals else '-'
cols = ['accepted', 'db_delivered', 'db_failed', 'dropped', 'p95_ms', 'e2e_seconds', 'e2e_per_min', 'app_cpu_max', 'k6_cpu_max']
print('| config | runs | ' + ' | '.join(f'{c} median (range)' for c in cols) + ' |')
print('|---|---|' + '---|' * len(cols))
for name, runs in groups.items():
    cells = []
    for c in cols:
        vals = [r[c] for _, r in runs if r.get(c) is not None]
        cells.append(f'{med(vals):g} ({rng(vals)})' if vals else '-')
    print(f'| {name} | {len(runs)} | ' + ' | '.join(cells) + ' |')
print('\nper run:')
for name, runs in groups.items():
    for stem, r in runs: print(stem, json.dumps({k: v for k, v in r.items() if v is not None}))
