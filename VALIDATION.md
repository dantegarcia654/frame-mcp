# Developer preview validation — November 2, 2026

The current source snapshot was installed into a new virtual environment on an Apple Silicon Mac with Python 3.9.6. FFmpeg and ffprobe were already installed. The release copy ran independently on an alternate loopback port with empty project storage.

Actual stdio MCP checks passed:

1. Initialize the packaged server.
2. Discover all 16 tools through one connector.
3. Import a newly generated three-second video with tone audio.
4. Trim it to two seconds with the current version.
5. Reject a stale version.
6. Undo to the original three seconds.
7. Redo to the two-second trim.
8. Complete an actual FFmpeg export.
9. Measure the output at two seconds.
10. Verify H.264 video and AAC audio.
11. Decode the entire exported MP4 without errors.
12. Reject an HTTP request with an untrusted Host.

The ChatGPT web integration was separately verified with an installed personal Frame plugin, an OpenAI Secure MCP Tunnel and an actual project read through ChatGPT. The managed tunnel reported running, healthy and ready. The original editor was also exercised through MCP import, trim, undo, redo and export from the local chat.

The portable setup helper downloaded the official tunnel-client release v0.0.19 for Apple Silicon, checked its published SHA256 and extracted it successfully. Source manifest hashes match the upstream snapshot. The release builder excludes runtime files and checks for embedded API keys and developer-specific paths. Linux and Windows have not been tested; the automatic tunnel installer currently supports macOS and Linux only. This is a Python source preview, not a signed native application or an approved public ChatGPT plugin-directory listing.
