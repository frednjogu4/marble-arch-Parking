#!/bin/bash
# Start Marble Arch Parking (backend :4000 + frontend :5173)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$ROOT/backend/.env" ]; then
  echo "Creating backend/.env from template..."
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
fi
echo "Starting backend on :4000 ..."
(cd "$ROOT/backend" && npm start > /tmp/ma-backend.log 2>&1 &) 
echo "Starting frontend on :5173 ..."
(cd "$ROOT/frontend" && npm run dev > /tmp/ma-frontend.log 2>&1 &)
sleep 3
echo "Backend:  http://localhost:4000/api"
echo "Frontend: http://localhost:5173"
echo "Logs: /tmp/ma-backend.log /tmp/ma-frontend.log"
