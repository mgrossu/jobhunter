# Linux container: pi + jobhunter, talking to a model server elsewhere (e.g. the Mac's MLX server).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata tini pandoc poppler-utils \
 && rm -rf /var/lib/apt/lists/*

ARG PI_VERSION=1.1.0
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ENV PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    JH_PROFILE=mac-mlx \
    TZ=Europe/Prague
RUN mkdir -p /home/node/.pi/agent /app/data /app/.jobhunter /app/out /app/reports /app/logs \
 && chown -R node:node /app /home/node/.pi
USER node
# Registers /jh-setup and /jh-review for interactive use inside the container.
RUN pi install /app

ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/docker/entrypoint.sh"]
CMD ["node", "src/schedule.ts"]
