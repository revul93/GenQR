#!/bin/sh
# GenQR command-line tools inside the container:
#   docker exec -it genqr genqr setup-token
#   docker exec -it genqr genqr reset-password admin --unlock
#   docker exec genqr genqr backup /app/backups/genqr-$(date +%F).json.gz
# Run `genqr help` for the full list. Service control and updates are done with Docker itself.
cd /app && exec node server/dist/cli/index.js "$@"
