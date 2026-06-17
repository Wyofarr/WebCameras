FROM node:20-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --production

# Copy app
COPY server/ ./server/
COPY public/ ./public/

# Runtime config directory (mount externally)
RUN mkdir -p /etc/webcameras /tmp/webcameras/hls

ENV PORT=8080
ENV CONFIG_PATH=/etc/webcameras
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server/index.js"]
