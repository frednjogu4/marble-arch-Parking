# Marble Arch Parking — single-service production image (API + UI on one port).
# Build:  docker build -t marble-arch-parking .
# Run:    docker run -p 4000:4000 -v parking-data:/data \
#           -e DB_PATH=/data/parking.db -e JWT_SECRET=... -e SEED_ADMIN_PASSWORD=... \
#           -e OPEN_ACCESS=false -e NO_LOGIN=false marble-arch-parking

# ---------- stage 1: build the React frontend ----------
FROM node:20-bookworm AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- stage 2: production runtime ----------
FROM node:20-bookworm
ENV NODE_ENV=production
WORKDIR /app

# Build tools for better-sqlite3's native compile (no-op if already present).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev --no-audit --no-fund

COPY backend/src ./backend/src
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# /data is the persistent-volume mount point (Railway volume / docker -v).
RUN mkdir -p /data /app/backend/data
ENV PORT=4000 DB_PATH=/data/parking.db
VOLUME /data
EXPOSE 4000
CMD ["node", "backend/src/server.js"]
