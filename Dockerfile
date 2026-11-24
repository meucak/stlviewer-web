FROM node:22-alpine

WORKDIR /app
COPY server ./server
COPY docs ./docs

RUN mkdir -p /app/server_data/shares /app/server_data/logs

ENV NODE_ENV=production
ENV PORT=8097
ENV DOCS_DIR=/app/docs
ENV DATA_DIR=/app/server_data
ENV TUNNEL_LOG_PATH=/app/server_data/logs/cloudflared.log

EXPOSE 8097
CMD ["node", "/app/server/server.mjs"]
