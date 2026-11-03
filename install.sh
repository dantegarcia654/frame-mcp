#!/usr/bin/env bash
set -euo pipefail
command -v python3 >/dev/null || { echo 'Install Python 3.9+ first.' >&2; exit 1; }
command -v codex >/dev/null || { echo 'Install the Codex CLI first: https://learn.chatgpt.com/docs/cli' >&2; exit 1; }
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo 'Install FFmpeg: brew install ffmpeg (macOS), or sudo apt install ffmpeg (Ubuntu).' >&2; exit 1; }
codex plugin add --help >/dev/null || { echo 'Update Codex to a version supporting plugins.' >&2; exit 1; }
frame_script_dir=''
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  frame_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fi
if [[ -n "$frame_script_dir" && -f "$frame_script_dir/plugins/frame/bootstrap.py" ]]; then
  frame_source="$frame_script_dir"
else
  command -v git >/dev/null || { echo 'Install Git first.' >&2; exit 1; }
  frame_downloads="$HOME/.local/share/frame-mcp"
  mkdir -p "$frame_downloads"
  frame_source="$frame_downloads/marketplace"
  if [[ -d "$frame_source/.git" ]]; then
    [[ "$(git -C "$frame_source" remote get-url origin)" == 'https://github.com/dantegarcia654/frame-mcp.git' ]] || { echo 'The Frame marketplace path has a different Git origin; no changes made.' >&2; exit 1; }
    [[ -z "$(git -C "$frame_source" status --porcelain)" ]] || { echo 'The Frame marketplace has local changes; preserve them before updating.' >&2; exit 1; }
    git -C "$frame_source" fetch --quiet --depth 1 origin tag v0.2.0
    git -C "$frame_source" -c advice.detachedHead=false checkout --quiet --detach v0.2.0
  elif [[ -e "$frame_source" ]]; then
    echo 'The Frame marketplace path already exists without its Git source; no changes made.' >&2; exit 1
  else
    frame_staging="$(mktemp -d "$frame_downloads/marketplace.install.XXXXXXXX")"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch v0.2.0 https://github.com/dantegarcia654/frame-mcp.git "$frame_staging"
    mv "$frame_staging" "$frame_source"
  fi
fi
python3 "$frame_source/plugins/frame/bootstrap.py" --prepare
codex plugin marketplace add "$frame_source"
codex plugin add frame@frame-desktop
printf '\nFrame installed. New chats discover its video-edit skill and MCP tools.\n'
printf 'For this installation chat, read: %s/plugins/frame/skills/frame-video-edit/SKILL.md\n' "$frame_source"
printf 'Immediate command: python3 "%s/plugins/frame/bootstrap.py" --call open_editor\n' "$frame_source"
printf 'Ask Codex: "Edit my video with Frame." Local macOS/Linux runtime; no model API key required.\n'
printf 'Health check: python3 "%s/plugins/frame/bootstrap.py" --doctor\n' "$frame_source"
printf 'Safe idle stop: python3 "%s/plugins/frame/bootstrap.py" --stop\n' "$frame_source"
