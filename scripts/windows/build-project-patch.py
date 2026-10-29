"""Build a code-only Windows patch against the actual migration backup layout.

The original runtime kit supplies the reviewed baseline hashes. The backup is
read without extraction; missing bridge files are supplied as a complete plugin.
Existing source must still match a reviewed baseline or the intended new file.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parents[2]
BRIDGE = 'astrbot_plugin_longtu_bridge/'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def build(backup, template, output):
    original = json.loads((template / 'PROJECT-PATCH.json').read_text())
    baseline = {item['path']: item for item in original['files']}
    tracked = subprocess.check_output(
        ['git', 'ls-files', '-z', '--', BRIDGE], cwd=ROOT,
    ).decode().split('\0')
    bridge_files = {name for name in tracked if name}
    if f'{BRIDGE}main.py' not in bridge_files:
        raise ValueError('The full tracked bridge plugin is required.')
    paths = sorted(set(baseline) | bridge_files)
    payload = {}
    for name in paths:
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or '\\' in name:
            raise ValueError(f'Invalid patch path: {name}')
        payload[name] = (ROOT / name).read_bytes()

    # Reading tar members rather than extracting avoids following backup links.
    before = {}
    legacy_bridge = False
    with tarfile.open(backup, 'r|gz') as archive:
        for member in archive:
            name = member.name.removeprefix('./')
            if name.startswith('astrabot_plugin_longtu_bridge/'):
                legacy_bridge = True
            if name not in payload:
                continue
            if not member.isfile() or name in before:
                raise ValueError(f'Ambiguous/non-regular source in backup: {name}')
            with archive.extractfile(member) as stream:
                before[name] = hashlib.file_digest(stream, 'sha256').hexdigest()

    files = []
    for name, data in payload.items():
        old_hash = before.get(name)
        new_hash = sha256(data)
        expected = baseline.get(name, {}).get('beforeSha256')
        if old_hash is not None and old_hash not in {expected, new_hash}:
            raise ValueError(f'Backup source differs from reviewed baseline: {name}')
        if old_hash is None and expected and not name.startswith(BRIDGE):
            raise ValueError(f'Required backend source missing from backup: {name}')
        files.append({'path': name, 'beforeSha256': old_hash, 'sha256': new_hash})

    manifest = {
        'baseCommit': original['baseCommit'],
        'backupLayoutVerifiedAgainst': backup.name,
        'legacyBridgeDirectoryPreserved': legacy_bridge,
        'files': files,
    }
    prefix = output.stem + '/'
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(prefix + 'PROJECT-PATCH.json', json.dumps(manifest, indent=2) + '\n')
        bundle.writestr(prefix + 'apply-project-patch.ps1',
                        payload['scripts/windows/apply-project-patch.ps1'])
        for name, data in payload.items():
            bundle.writestr(prefix + 'project-patch/' + name, data)
    with zipfile.ZipFile(output) as bundle:
        if bundle.testzip() is not None:
            raise ValueError('Generated ZIP integrity check failed.')
        for item in files:
            if sha256(bundle.read(prefix + 'project-patch/' + item['path'])) != item['sha256']:
                raise ValueError(f"Generated file hash mismatch: {item['path']}")
    with output.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(f'{digest}  {output.name}\n')
    print(f'Created {output}: {len(files)} files, {output.stat().st_size} bytes')
    print(f'Full bridge files: {len(bridge_files)}; existing source hashes verified: {len(before)}')
    print(f'SHA256: {digest}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--template', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.backup, args.template, args.output)
