FROM node:18-slim

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

RUN if [ -f cookies.txt ]; then cp cookies.txt /app/cookies.txt; fi

EXPOSE 3000

CMD ["node", "server.js"]