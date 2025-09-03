#!/bin/bash

# TimeStream Test Environment Setup Script

set -e

echo "🚀 TimeStream Test Environment Setup"
echo "===================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}❌ Docker Compose is not installed. Please install Docker Compose first.${NC}"
    exit 1
fi

# Function to wait for service to be healthy
wait_for_service() {
    local service=$1
    local url=$2
    local max_attempts=30
    local attempt=0
    
    echo -n "Waiting for $service to be ready"
    while [ $attempt -lt $max_attempts ]; do
        if curl -f -s "$url" > /dev/null 2>&1; then
            echo -e " ${GREEN}✓${NC}"
            return 0
        fi
        echo -n "."
        sleep 2
        attempt=$((attempt + 1))
    done
    echo -e " ${RED}✗${NC}"
    return 1
}

# Parse command line arguments
ACTION=${1:-start}

case $ACTION in
    start)
        echo "Starting test environment..."
        echo ""
        
        # Build the packages first
        echo "Building TimeStream packages..."
        npm run build
        echo -e "${GREEN}✓ Packages built successfully${NC}"
        echo ""
        
        # Start Docker containers
        echo "Starting Docker containers..."
        docker-compose -f docker-compose.test.yml up -d
        echo ""
        
        # Wait for services to be ready
        echo "Waiting for services to start..."
        wait_for_service "Grafana" "http://localhost:3000/api/health"
        wait_for_service "Loki" "http://localhost:3100/ready"
        wait_for_service "Prometheus" "http://localhost:9090/-/ready"
        wait_for_service "InfluxDB" "http://localhost:8086/health"
        
        echo ""
        echo -e "${GREEN}✅ Test environment is ready!${NC}"
        echo ""
        echo "Services available at:"
        echo "  • Grafana:    http://localhost:3000 (admin/admin)"
        echo "  • Loki:       http://localhost:3100"
        echo "  • Prometheus: http://localhost:9090"
        echo "  • InfluxDB:   http://localhost:8086"
        echo ""
        echo "Next steps:"
        echo "1. Create a Grafana API key:"
        echo "   - Go to http://localhost:3000/org/apikeys"
        echo "   - Create a new API key with 'Viewer' role"
        echo "   - Copy the key"
        echo ""
        echo "2. Configure data sources in Grafana:"
        echo "   - Go to http://localhost:3000/datasources"
        echo "   - Add Loki data source (URL: http://loki:3100)"
        echo "   - Add Prometheus data source (URL: http://prometheus:9090)"
        echo ""
        echo "3. Run the test script:"
        echo "   export GRAFANA_TOKEN='your-api-key-here'"
        echo "   node test-grafana-integration.js"
        ;;
        
    stop)
        echo "Stopping test environment..."
        docker-compose -f docker-compose.test.yml down
        echo -e "${GREEN}✓ Test environment stopped${NC}"
        ;;
        
    clean)
        echo "Cleaning test environment..."
        docker-compose -f docker-compose.test.yml down -v
        echo -e "${GREEN}✓ Test environment cleaned${NC}"
        ;;
        
    logs)
        docker-compose -f docker-compose.test.yml logs -f
        ;;
        
    test)
        echo "Running tests..."
        echo ""
        
        # Check if Grafana token is set
        if [ -z "$GRAFANA_TOKEN" ]; then
            echo -e "${YELLOW}⚠️  GRAFANA_TOKEN not set. Only testing direct connections.${NC}"
            node test-grafana-integration.js --direct
        else
            node test-grafana-integration.js
        fi
        ;;
        
    *)
        echo "Usage: $0 {start|stop|clean|logs|test}"
        echo ""
        echo "Commands:"
        echo "  start  - Start the test environment"
        echo "  stop   - Stop the test environment"
        echo "  clean  - Stop and remove all data"
        echo "  logs   - Show logs from all services"
        echo "  test   - Run the integration tests"
        exit 1
        ;;
esac