#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/meli-painel"
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Execute como root: sudo bash deploy.sh" >&2
  exit 1
fi
if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR nao e um repositorio Git." >&2
  exit 1
fi
cd "$APP_DIR"
git pull --ff-only
npm install
pm2 restart meli --update-env
pm2 save
echo "Deploy concluido."
