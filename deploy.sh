#!/usr/bin/env bash
set -e

# ── Chronos EC2 Deployment Script ─────────────────────────────────────────────
SERVER="ec2-user@54.87.25.180"
PEM_KEY="./codeity.pem"
REMOTE_DIR="/home/ec2-user/chronos"

echo ">>> Starting Chronos EC2 Deployment..."

# ── 1. Create local archive ────────────────────────────────────────────────────
echo ">>> [1/5] Archiving project files..."
tar \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./dist' \
  --exclude='./.env' \
  --exclude='./chronos-deploy.tar.gz' \
  --exclude='./api/node_modules' \
  --exclude='./worker/node_modules' \
  --exclude='./web/node_modules' \
  --exclude='./web/.next' \
  -czf chronos-deploy.tar.gz .

# ── 2. Create remote directory ─────────────────────────────────────────────────
echo ">>> [2/5] Preparing remote directory..."
ssh -i "$PEM_KEY" -o StrictHostKeyChecking=no "$SERVER" "mkdir -p $REMOTE_DIR"

# ── 3. Upload archive + .env ──────────────────────────────────────────────────
echo ">>> [3/5] Uploading to EC2 ($SERVER)..."
scp -i "$PEM_KEY" -o StrictHostKeyChecking=no chronos-deploy.tar.gz .env "$SERVER:$REMOTE_DIR/"

# ── 4. Remote: extract, install docker, start services ────────────────────────
echo ">>> [4/5] Running remote setup..."
ssh -i "$PEM_KEY" -o StrictHostKeyChecking=no "$SERVER" bash << ENDSSH

set -e
cd $REMOTE_DIR

echo "  -> Extracting archive..."
tar -xzf chronos-deploy.tar.gz
rm chronos-deploy.tar.gz

# Install Docker if not present (Amazon Linux 2023)
if ! command -v docker &>/dev/null; then
  echo "  -> Installing Docker..."
  sudo dnf update -y
  sudo dnf install -y docker
  sudo systemctl start docker
  sudo systemctl enable docker
  sudo usermod -aG docker ec2-user
fi

# Install Docker Compose plugin if not present
if ! sudo docker compose version &>/dev/null 2>&1; then
  echo "  -> Installing Docker Compose plugin..."
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -SL "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

echo "  -> Docker Compose version: \$(sudo docker compose version)"

# Start services
if [ -f .env ]; then
  echo "  -> .env found. Starting containers..."
  sudo docker compose down --remove-orphans 2>/dev/null || true
  sudo docker compose up -d --build
  echo "  -> Waiting 10s for services to stabilise..."
  sleep 10
  echo "  -> Container status:"
  sudo docker compose ps
else
  echo "  -> ERROR: .env not found in $REMOTE_DIR. Deployment aborted."
  exit 1
fi

ENDSSH

# ── 5. Cleanup ─────────────────────────────────────────────────────────────────
echo ">>> [5/5] Cleaning up local archive..."
rm -f chronos-deploy.tar.gz

echo ""
echo ">>> Deployment complete!"
echo ">>> Dashboard: http://54.87.25.180"
echo ">>> Swagger:   http://54.87.25.180/api/docs"
echo ">>> Health:    http://54.87.25.180/api/health"
