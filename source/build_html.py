"""Build the standalone offline atlas using only this repository and Python stdlib."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / 'index.html'


def main():
    education = json.loads((ROOT / 'education.json').read_text(encoding='utf-8'))
    for module in education:
        if module['id'] in ('frontal', 'occipital', 'cerebellum', 'thalamus'):
            module['source'] = module['id']
        if module['id'] in ('pons', 'midbrain'):
            module['source'] = 'brainstem'
        for key in ('gyri', 'offset', 'center'):
            module.pop(key, None)

    meta = json.loads((ROOT / 'geometry.json').read_text(encoding='utf-8'))
    palette = {module['id']: module['color'] for module in education}
    palette['context'] = '#dca695'
    for component in meta['components']:
        component['color'] = palette[component['id']]

    compact = {'ensure_ascii': False, 'separators': (',', ':')}
    geometry = (ROOT / 'geometry.gz.b64').read_text(encoding='utf-8').strip()
    data = (
        'const EDUCATION=' + json.dumps(education, **compact) + ';\n'
        'const META=' + json.dumps(meta, **compact) + ';\n'
        'const GEOMETRY="' + geometry + '";\n'
    )
    replacements = {
        '@@MODEL_THEME@@': (ROOT / 'model-theme.css').read_text(encoding='utf-8'),
        '@@MODEL_DATA@@': data,
        '@@MODEL_VIEWER@@': (ROOT / 'viewer.js').read_text(encoding='utf-8'),
    }
    html = (ROOT / 'template.html').read_text(encoding='utf-8')
    for token, value in replacements.items():
        if html.count(token) != 1:
            raise ValueError(f'Expected exactly one template token: {token}')
        html = html.replace(token, value, 1)
    OUT.write_bytes(html.encode('utf-8'))
    print(f'Built {OUT.name}: {len(html.encode("utf-8")):,} bytes')


if __name__ == '__main__':
    main()
