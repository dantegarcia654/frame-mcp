#!/usr/bin/env python3
"""Serve MCP; the bridge starts and verifies its own runtime before tool calls."""
import runpy
import sys
from pathlib import Path
root = Path(__file__).resolve().parent / 'frame'
sys.path.insert(0, str(root))
runpy.run_path(str(root / 'quick_mcp.py'), run_name='__main__')
