#!/usr/bin/env bash
# Starts the Firebase Auth Emulator for fully offline local login.
# Runs entirely on your machine — no real Firebase project data is touched,
# and no `firebase login` is required.
#
#   ./scripts/emulator.sh
#
# UI:  http://127.0.0.1:4000/auth
# API: http://127.0.0.1:9099
#
# BE picks this up automatically via FIREBASE_AUTH_EMULATOR_HOST in .env.
# FE picks this up automatically via EXPO_PUBLIC_USE_EMULATOR in .env.
# Both are set by ./scripts/set-mode.sh local.
#
# Test accounts persist across restarts in .firebase-emulator-data/ (loaded on
# start, saved on a clean exit — stop with Ctrl+C, not `kill -9`).

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
DATA_DIR="$ROOT_DIR/.firebase-emulator-data"
mkdir -p "$DATA_DIR"
firebase emulators:start --only auth --project lalaba-kwyky-ecosystem \
  --import="$DATA_DIR" --export-on-exit="$DATA_DIR"
