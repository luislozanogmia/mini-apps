"""Deterministic runtime-only ZIP. No profiles, cookies, test data or dependencies."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
source = root / 'extension'
version = json.loads((source / 'manifest.json').read_text())['version']
output = root / 'output'
output.mkdir(exist_ok=True)
archive = output / f'slop-filter-{version}.zip'
files = ['manifest.json', 'engine.js', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css']
files += [f'icons/{size}.png' for size in [16, 32, 48, 128]]
with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
    for filename in sorted(files):
        info = ZipInfo(filename, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, (source / filename).read_bytes())
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(archive.with_suffix('.zip.sha256')).write_text(f'{checksum}  {archive.name}\n')
print(f'{archive}\nSHA-256 {checksum}')

# Friend bundle adds onboarding outside the exact same runtime folder.
friends = output / f'slop-filter-{version}-friends.zip'
with ZipFile(friends, 'w', ZIP_DEFLATED) as z:
    for filename in sorted(files):
        info = ZipInfo('slop-filter/' + filename, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, (source / filename).read_bytes())
    for filename in ['START-HERE.html', 'PRIVACY.md', 'LICENSE']:
        info = ZipInfo(filename, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, (root / filename).read_bytes())
    preset = {'format': 'slop-filter-preset', 'version': 1, 'name': 'Balanced', 'settings': {'tells': ['engagement', 'hooks', 'contrast', 'story', 'buzzwords'], 'phrases': [], 'threshold': 1}}
    info = ZipInfo('balanced.preset.json', date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = ZIP_DEFLATED
    z.writestr(info, json.dumps(preset, indent=2) + '\n')
checksum = hashlib.sha256(friends.read_bytes()).hexdigest()
(friends.with_suffix('.zip.sha256')).write_text(f'{checksum}  {friends.name}\n')
print(f'{friends}\nSHA-256 {checksum}')
