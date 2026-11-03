#!/usr/bin/env python3
"""Use the Frame editing tools from a terminal in the same cloud workspace."""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
config = ROOT / 'runtime.json'
if config.exists():
    os.environ.setdefault('FRAME_URL', json.loads(config.read_text())['base_url'])
sys.path.insert(0, str(ROOT / 'frame'))
import quick_mcp
import quick_runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tool', help='A tool name, or tools to list schemas')
    parser.add_argument('arguments', nargs='?', default='{}', help='JSON object')
    args = parser.parse_args()
    if args.tool == 'tools':
        print(json.dumps(quick_mcp.tools(), indent=2))
        return
    values = json.loads(args.arguments)
    if not isinstance(values, dict):
        parser.error('arguments must be a JSON object')
    quick_runtime.ensure_server(quick_mcp.BASE)
    response = quick_mcp.dispatch({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                  'params': {'name': args.tool, 'arguments': values}})
    result = response.get('result', {})
    # Do not print app-only video transport to the model or terminal.
    if response.get('error') or result.get('isError'):
        print(json.dumps(response.get('error') or result.get('content')), file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result.get('structuredContent', {}), indent=2))


if __name__ == '__main__':
    main()
