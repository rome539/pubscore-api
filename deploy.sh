#!/bin/bash
# deploy.sh — One-shot setup script for PubScore API on the VPS
# Run as: ssh deploy@167.172.252.175 'bash -s' < deploy.sh
# OR copy files first, then run on the server

set -e

echo "=== PubScore API Deployment ==="

# 1. Install Node.js 20 LTS
echo "[1/6] Installing Node.js 20..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "  Node.js already installed: $(node --version)"
fi

# 2. Install PM2 globally
echo "[2/6] Installing PM2..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
else
    echo "  PM2 already installed: $(pm2 --version)"
fi

# 3. Set up project directory
echo "[3/6] Setting up project..."
mkdir -p ~/pubscore-api/data
cd ~/pubscore-api

# 4. Install dependencies
echo "[4/6] Installing npm dependencies..."
npm install

# 5. Configure Caddy
echo "[5/6] Configuring Caddy..."
CADDY_CONFIG="api.pubscore.space {
    reverse_proxy localhost:3000
}"

# Check if already configured
if ! grep -q "api.pubscore.space" /etc/caddy/Caddyfile 2>/dev/null; then
    echo "" | sudo tee -a /etc/caddy/Caddyfile
    echo "$CADDY_CONFIG" | sudo tee -a /etc/caddy/Caddyfile
    echo "  Added api.pubscore.space to Caddyfile"
    sudo systemctl reload caddy
else
    echo "  Caddy already configured for api.pubscore.space"
fi

# 6. Start with PM2
echo "[6/6] Starting with PM2..."
pm2 stop pubscore-api 2>/dev/null || true
pm2 delete pubscore-api 2>/dev/null || true
pm2 start server.js --name pubscore-api --max-memory-restart 200M
pm2 save
pm2 startup 2>/dev/null || echo "  Run the pm2 startup command above if prompted"

echo ""
echo "=== Deployment Complete ==="
echo "API should be live at https://api.pubscore.space once DNS propagates"
echo ""
echo "Useful commands:"
echo "  pm2 logs pubscore-api     — view logs"
echo "  pm2 restart pubscore-api  — restart"
echo "  pm2 monit                 — monitor CPU/RAM"
echo "  curl localhost:3000/health — test locally"
