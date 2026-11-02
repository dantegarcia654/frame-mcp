#!/usr/bin/env python3
"""Start the existing Frame editor on loopback."""
import os
import runpy
import sys
from pathlib import Path

root = Path(__file__).resolve().parent / 'frame'
sys.path.insert(0, str(root))
os.environ.setdefault('PORT', '8876')
runpy.run_path(str(root / 'app.py'), run_name='__main__')
