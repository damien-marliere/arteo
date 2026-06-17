# Image de production pour efacture
FROM node:22-slim

WORKDIR /app

# Dépendances (cache Docker)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm install tsx

# Code
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Données persistées dans un volume
ENV DB_PATH=/data/db.json
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000

CMD ["npx", "tsx", "src/server.ts"]
