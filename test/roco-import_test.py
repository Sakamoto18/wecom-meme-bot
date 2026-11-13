import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('roco_import', Path(__file__).parents[1] / 'scripts/import-roco-wiki.py')
wiki = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wiki)


def page(html):
    return {'parse': {'text': {'*': html}, 'revid': 123}}


class WikiImportTest(unittest.TestCase):
    def test_same_display_name_keeps_forms_and_icon_attributes(self):
        headers = ['number', 'avatar', 'name', 'types', 'ride', 'doubleRide']
        html = '<table class="npc-table"><tr>' + ''.join('<th data-column="%s">%s</th>' % (k, k) for k in headers) + '</tr>'
        for form in ['蓬松', '紧实']:
            html += '<tr data-type="普通"><td>011</td><td><img src="x"></td><td><a href="/nrc/鸭吉吉（%s）">鸭吉吉</a></td><td data-sort-value="普通"></td><td><span aria-label="可骑乘"></span></td><td>—</td></tr>' % form
        records = wiki.parse_index(page(html + '</table>'), 'pet')
        self.assertEqual(len({r['id'] for r in records}), 2)
        self.assertEqual(records[0]['aliases'], ['鸭吉吉'])
        self.assertEqual(records[0]['fields']['ride'], '可骑乘')
        self.assertEqual(records[0]['fields']['types'], '普通')

    def test_skill_sources_and_missing_detail_fail_closed(self):
        html = '<div data-sd-kind="pet" data-nrc-codex="精灵图鉴/S5"><div class="sd-p-skill-card" data-source="level" data-name="抓挠" data-level="1" data-power="35" data-energy="0"><div class="sd-p-skill-description">造成物伤，自己回复1能量。</div></div></div>'
        skills, version = wiki.parse_pet(page(html))
        self.assertEqual(version, '精灵图鉴/S5')
        self.assertEqual(skills[0]['习得'], '自学')
        self.assertEqual(skills[0]['能耗'], '0')
        self.assertIn('1能量', skills[0]['效果'])
        with self.assertRaisesRegex(ValueError, 'Missing public'):
            wiki.parse_pet(page('<html>visitor check</html>'))

    def test_incomplete_import_never_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'knowledge.sqlite'
            target.write_bytes(b'previous-good-snapshot')
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                wiki.save_snapshot(target, [])
            self.assertEqual(target.read_bytes(), b'previous-good-snapshot')

    def test_traits_read_owner_title_instead_of_form_count(self):
        html = '<table class="nrc-skill-table"><tr>' + ''.join('<th>%s</th>' % x for x in ['特性', '特性名称', '携带精灵系别', '拥有精灵', '特性效果']) + '</tr><tr><td></td><td><a href="/nrc/氧循环">氧循环</a></td><td data-sort-value="草"></td><td title="喵喵、喵呜">2 个形态</td><td>使用草系技能后，回复10%生命。</td></tr></table>'
        record = wiki.parse_index(page(html), 'trait')[0]
        self.assertEqual(record['fields']['拥有精灵'], '喵喵、喵呜')
        self.assertEqual(record['fields']['携带精灵系别'], '草')


if __name__ == '__main__':
    unittest.main()
