# Car Soccer: build the static site, then serve it with nginx.
# There is no game server: the hosting player's browser runs each match, so this container
# only hands out files. Put it behind your HTTPS proxy; browsers only allow WebRTC on HTTPS.

FROM node:22-alpine AS build
WORKDIR /app
# git lets the build stamp its commit on the menu (vite.config.ts); it falls back to "unknown".
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
