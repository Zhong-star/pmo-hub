FROM node:22-alpine AS workspace

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/hub/package.json apps/hub/package.json
COPY apps/lessons-learned/package.json apps/lessons-learned/package.json
COPY services/hub-api/package.json services/hub-api/package.json
COPY services/lessons-learned-api/package.json services/lessons-learned-api/package.json

RUN npm ci

COPY apps ./apps
COPY services ./services

FROM workspace AS hub-build
RUN npm run contracts:generate \
    && npm run build --workspace @pmo-hub/hub

FROM nginx:1.27-alpine AS hub
COPY docker/nginx/hub.conf /etc/nginx/conf.d/default.conf
COPY --from=hub-build /workspace/apps/hub/dist/ /usr/share/nginx/html/
EXPOSE 8080

FROM workspace AS lessons-learned-build
RUN npm run contracts:generate \
    && npm run build --workspace @pmo-hub/lessons-learned

FROM nginx:1.27-alpine AS lessons-learned
COPY docker/nginx/lessons-learned.conf /etc/nginx/conf.d/default.conf
COPY --from=lessons-learned-build /workspace/apps/lessons-learned/dist/ /usr/share/nginx/html/
EXPOSE 8080

FROM workspace AS hub-api-build
RUN npm run build --workspace @pmo-hub/hub-api

FROM node:22-alpine AS hub-api
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    HUB_LOCAL_USERS_FILE=/app/config/local-users.json

COPY package.json package-lock.json ./
COPY apps/hub/package.json apps/hub/package.json
COPY apps/lessons-learned/package.json apps/lessons-learned/package.json
COPY services/hub-api/package.json services/hub-api/package.json
COPY services/lessons-learned-api/package.json services/lessons-learned-api/package.json
RUN npm ci --omit=dev --workspace @pmo-hub/hub-api

WORKDIR /app/services/hub-api
COPY --from=hub-api-build /workspace/services/hub-api/dist/ ./dist/
COPY --from=hub-api-build /workspace/services/hub-api/config/local-users.json /app/config/local-users.json
EXPOSE 3001
CMD ["node", "dist/main.js"]

FROM workspace AS lessons-learned-api-build
RUN npm run build --workspace @pmo-hub/lessons-learned-api

FROM node:22-alpine AS lessons-learned-api
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002

COPY package.json package-lock.json ./
COPY apps/hub/package.json apps/hub/package.json
COPY apps/lessons-learned/package.json apps/lessons-learned/package.json
COPY services/hub-api/package.json services/hub-api/package.json
COPY services/lessons-learned-api/package.json services/lessons-learned-api/package.json
RUN npm ci --omit=dev --workspace @pmo-hub/lessons-learned-api

WORKDIR /app/services/lessons-learned-api
COPY --from=lessons-learned-api-build /workspace/services/lessons-learned-api/dist/ ./dist/
COPY --from=lessons-learned-api-build /workspace/services/lessons-learned-api/config/local-users.json ./config/local-users.json
EXPOSE 3002
CMD ["node", "dist/main.js"]
