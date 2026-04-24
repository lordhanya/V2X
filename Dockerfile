FROM node:18.20.4-slim

RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && ln -sf /usr/local/bin/yt-dlp /usr/local/bin/youtube-dl

RUN yt-dlp --version
RUN ffmpeg -version

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

CMD ["sh", "-c", "yt-dlp -U --no-update-info 2>/dev/null || true && node server.js"]