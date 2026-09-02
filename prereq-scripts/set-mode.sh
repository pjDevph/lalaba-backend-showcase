#!/usr/bin/env bash
# Flips the BE and FE online/local switches together so they never drift apart.
#
#   ./scripts/set-mode.sh local   -> BE MONGODB_ONLINE=off, FE EXPO_PUBLIC_ONLINE=off,
#                                    Firebase Auth Emulator ON (fully offline login)
#   ./scripts/set-mode.sh online  -> BE MONGODB_ONLINE=on,  FE EXPO_PUBLIC_ONLINE=on,
#                                    Firebase Auth Emulator OFF (real Firebase project)
#
# local  = local NestJS backend + local Docker MongoDB + FE points at the LAN IP backend
#          + login goes through the local Firebase Auth Emulator (scripts/emulator.sh)
# online = FE points at the hosted Render backend, which itself talks to Atlas
#          + login goes through the real Firebase project
#
# Restart `npm run start:dev` (BE) and `npm start` (FE/Metro) after switching —
# both envs are read at process/bundle start, not live.

set -euo pipefail

MODE="${1:-}"
if [[ "$MODE" != "local" && "$MODE" != "online" ]]; then
  echo "Usage: $0 local|online" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BE_ENV="$ROOT_DIR/LALABA_BE_DEV/.env"
FE_ENV="$ROOT_DIR/LALABA_MERCHANT_APP_DEV/.env"

for f in "$BE_ENV" "$FE_ENV"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing $f — copy its .env.example first." >&2
    exit 1
  fi
done

VALUE="off"
EMULATOR_HOST=""
USE_EMULATOR="false"
if [[ "$MODE" == "online" ]]; then
  VALUE="on"
else
  EMULATOR_HOST="localhost:9099"
  USE_EMULATOR="true"
fi

sed -i.bak "s/^MONGODB_ONLINE=.*/MONGODB_ONLINE=${VALUE}/" "$BE_ENV" && rm -f "${BE_ENV}.bak"
sed -i.bak "s/^EXPO_PUBLIC_ONLINE=.*/EXPO_PUBLIC_ONLINE=${VALUE}/" "$FE_ENV" && rm -f "${FE_ENV}.bak"
sed -i.bak "s/^FIREBASE_AUTH_EMULATOR_HOST=.*/FIREBASE_AUTH_EMULATOR_HOST=${EMULATOR_HOST}/" "$BE_ENV" && rm -f "${BE_ENV}.bak"
sed -i.bak "s/^EXPO_PUBLIC_USE_EMULATOR=.*/EXPO_PUBLIC_USE_EMULATOR=${USE_EMULATOR}/" "$FE_ENV" && rm -f "${FE_ENV}.bak"

# STORAGE_ONLINE is not written here any more: it only ever chose between
# Firebase Storage and Docker MinIO, and MinIO is gone. Local media is the
# Storage Emulator, selected by FIREBASE_STORAGE_EMULATOR_HOST — which is
# left alone because it must hold this machine's LAN IP, not localhost
# (image URLs are handed to devices).
echo "Backend  (LALABA_BE_DEV):            MONGODB_ONLINE=${VALUE}  FIREBASE_AUTH_EMULATOR_HOST=${EMULATOR_HOST}"
echo "Frontend (LALABA_MERCHANT_APP_DEV):  EXPO_PUBLIC_ONLINE=${VALUE}  EXPO_PUBLIC_USE_EMULATOR=${USE_EMULATOR}"
echo
echo "Restart both to apply:"
echo "  cd LALABA_BE_DEV && npm run start:dev"
echo "  cd LALABA_MERCHANT_APP_DEV && npm start"

if [[ "$MODE" == "local" ]]; then
  echo
  echo "Local mode needs:"
  echo "  cd LALABA_BE_DEV && npm run db:up        # local MongoDB"
  echo "  ./scripts/emulator.sh                    # local Firebase Auth + Storage (separate terminal)"
  echo
  echo "Check FIREBASE_STORAGE_EMULATOR_HOST in LALABA_BE_DEV/.env points at this"
  echo "machine's LAN IP on :9199 — localhost there breaks images on devices."
  echo
  echo "Note: the emulator has its own empty user store — register a fresh test"
  echo "account through the app; your real Firebase accounts won't exist there."
fi
