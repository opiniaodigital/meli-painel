#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/meli-painel"
REPO_URL="${REPO_URL:-https://github.com/opiniaodigital/meli-painel.git}"
DOMAIN="${1:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Execute como root: sudo bash setup-servidor.sh seu-dominio.com.br" >&2
  exit 1
fi
if [[ -z "$DOMAIN" || ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ || "$DOMAIN" == -* ]]; then
  echo "Uso: sudo bash setup-servidor.sh seu-dominio.com.br" >&2
  exit 1
fi
if [[ "$REPO_URL" == *"SEU-USUARIO"* ]]; then
  echo "Defina REPO_URL com o repositorio real antes de executar." >&2
  echo "Exemplo: sudo REPO_URL=https://github.com/opiniaodigital/meli-painel.git bash setup-servidor.sh $DOMAIN" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]]; then
  curl --fail --silent --show-error --location https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y caddy
npm install --global pm2

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
elif [[ -e "$APP_DIR" ]]; then
  echo "$APP_DIR existe, mas nao e um repositorio Git." >&2
  exit 1
else
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
if [[ ! -f package.json ]]; then
  echo "package.json nao encontrado em $APP_DIR." >&2
  exit 1
fi
npm install
if [[ ! -f .env && -f .env.example ]]; then
  install -m 600 .env.example .env
fi
if [[ ! -f .env ]]; then
  echo "Aviso: .env.example nao existe; crie $APP_DIR/.env antes de iniciar o app." >&2
fi

if pm2 describe meli >/dev/null 2>&1; then
  pm2 restart meli --update-env
else
  if [[ -f ecosystem.config.cjs ]]; then
    pm2 start ecosystem.config.cjs --name meli --update-env
  elif [[ -f server.js ]]; then
    pm2 start server.js --name meli --update-env
  elif [[ -f index.js ]]; then
    pm2 start index.js --name meli --update-env
  else
    echo "Nao encontrei o ponto de entrada (ecosystem.config.cjs, server.js ou index.js)." >&2
    exit 1
  fi
fi
pm2 save
PM2_STARTUP="$(pm2 startup systemd -u root --hp /root | tail -n 1)"
if [[ "$PM2_STARTUP" == sudo* ]]; then
  bash -c "$PM2_STARTUP"
fi
pm2 save

install -d -m 755 /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
}
EOF
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy

echo "Servidor configurado para https://$DOMAIN"
echo "App: $APP_DIR | PM2: meli | Proxy: 127.0.0.1:3000"
