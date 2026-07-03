#!/bin/bash
set -e

# Chronos EC2 Deployment Script
SERVER="ubuntu@54.87.25.180"
PEM_KEY="~/.ssh/chronos-deploy.pem"

echo "🚀 Starting Chronos EC2 Deployment..."

# 1. Archive the project (excluding node_modules and dist)
echo "📦 Archiving project files..."
tar --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='.env' -czf chronos-deploy.tar.gz .

# 2. Upload to EC2
echo "📤 Uploading to EC2 ($SERVER)..."
scp -i "$PEM_KEY" -o StrictHostKeyChecking=no chronos-deploy.tar.gz $SERVER:/home/ubuntu/

# 3. Execute remote setup and launch
echo "🔧 Executing remote deployment commands..."
ssh -i "$PEM_KEY" -o StrictHostKeyChecking=no $SERVER << 'EOF'
  set -e
  echo "Extracting archive..."
  mkdir -p ~/chronos
  tar -xzf chronos-deploy.tar.gz -C ~/chronos
  
  cd ~/chronos
  
  # Ensure Docker and Docker Compose are installed
  if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose
    sudo usermod -aG docker ubuntu
  fi

  # Start services
  echo "🚀 Starting containers with Docker Compose..."
  # Assuming .env is manually placed on the server securely
  if [ -f .env ]; then
    sudo docker-compose down
    sudo docker-compose up -d --build
    echo "✅ Deployment successful. Services are starting."
    sudo docker ps
  else
    echo "⚠️ WARNING: .env file not found on server! Services will fail to start. Please create ~/chronos/.env"
  fi
EOF

echo "🧹 Cleaning up local archive..."
rm chronos-deploy.tar.gz

echo "🎉 Deployment script finished!"
