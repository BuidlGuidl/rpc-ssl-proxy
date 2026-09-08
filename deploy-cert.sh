#!/bin/bash
# certbot --deploy-hook target: runs only when a new cert was actually issued.
# certbot passes the new cert's directory in RENEWED_LINEAGE.
set -euo pipefail

PROXY_DIR="/home/ubuntu/rpc-ssl-proxy"
LINEAGE="${RENEWED_LINEAGE:?RENEWED_LINEAGE is not set; this must be run by certbot}"

# pm2 finds its process registry via PM2_HOME, falling back to $HOME/.pm2. The
# proxy is registered under root's pm2, so pin it rather than inheriting HOME.
export PM2_HOME="/root/.pm2"

log() { printf '[%s] deploy-hook: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

cert_pub=$(/usr/bin/openssl x509 -noout -pubkey -in "$LINEAGE/fullchain.pem")
key_pub=$(/usr/bin/openssl pkey -pubout -in "$LINEAGE/privkey.pem")
if [[ "$cert_pub" != "$key_pub" ]]; then
  log "ABORT: $LINEAGE cert and key do not match; leaving existing cert in place"
  exit 1
fi

if ! /usr/bin/openssl x509 -checkend 86400 -noout -in "$LINEAGE/fullchain.pem" >/dev/null; then
  log "ABORT: new cert at $LINEAGE is already expiring; leaving existing cert in place"
  exit 1
fi

# 0640 root:ubuntu -- the proxy runs as root, and the old 0777 left the private
# key world-readable and world-writable.
install -o root -g ubuntu -m 0640 "$LINEAGE/privkey.pem" "$PROXY_DIR/server.key"
install -o root -g ubuntu -m 0644 "$LINEAGE/fullchain.pem" "$PROXY_DIR/server.cert"
log "installed cert valid until $(/usr/bin/openssl x509 -enddate -noout -in "$PROXY_DIR/server.cert" | cut -d= -f2)"

/usr/bin/pm2 restart proxy --update-env
log "restarted proxy"
