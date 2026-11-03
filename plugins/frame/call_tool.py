#!/usr/bin/env python3
"""CLI fallback for the same versioned tools, including the installation chat."""
import json
from pathlib import Path
import sys

runtime, endpoint, tool, arguments = sys.argv[1:]
sys.path.insert(0, str(Path(runtime) / 'frame'))
import quick_mcp
import quick_runtime
if tool == 'tools':
    result = {'tools': quick_mcp.tools()}
else:
    quick_runtime.ensure_server(endpoint)
    result = quick_mcp.dispatch({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                 'params': {'name': tool, 'arguments': json.loads(arguments)}})
print(json.dumps(result))
if result.get('error') or result.get('result', {}).get('isError'):
    sys.exit(1)
