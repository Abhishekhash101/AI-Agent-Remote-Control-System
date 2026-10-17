#!/usr/bin/env bash
# Helper script to send a prompt to Codex from any terminal
if [ -z "$1" ]; then
  echo "Usage: ./send_prompt.sh \"Your prompt for Codex\""
  exit 1
fi

echo "$*" > /tmp/agentbridge_prompt
echo "✓ Prompt forwarded to Codex and synced with your phone!"
