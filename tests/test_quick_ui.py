"""Contract checks for the browser quick-edit control surface.

Run: python -m unittest tests.test_quick_ui
Run from work/frame-product.
"""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]/"plugins/frame/runtime/frame"

class QuickEditContract(unittest.TestCase):
    def test_controls_are_in_left_panel(self):
        html=(ROOT/'quick.html').read_text()
        self.assertIn('<aside aria-label="FRAME editing controls">',html)
        self.assertIn('<main class="viewer"',html)
        left=html.split('<aside aria-label="FRAME editing controls">',1)[1].split('</aside>',1)[0]
        self.assertNotIn('<video',left)
        self.assertIn('id="timeline"',left)
        self.assertIn('id="proposal"',left)
        self.assertIn('id="approve"',left)
    def test_backend_integration(self):
        html=(ROOT/'quick.html').read_text()
        app=(ROOT/'app.py').read_text()
        for endpoint in ['/upload','/api/projects/','/edit','/approve','/reject','/select','/api/tasks/']:
            self.assertIn(endpoint,html)
        self.assertIn("if path in ('/quick', '/quick/'):",app)
    def test_no_fake_host_claim(self):
        html=(ROOT/'quick.html').read_text()
        self.assertIn('Browser fallback viewer',html)
        self.assertIn('Quick edits make a reviewable proposal',html)

if __name__=='__main__':unittest.main()
