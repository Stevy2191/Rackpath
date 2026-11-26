# ---- Build stage ----
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
# npm ci installs exactly the locked (audited) dependency versions.
RUN npm ci

COPY . .
# Emit the webpack runtime as a file instead of an inline <script>, so the
# Content-Security-Policy in nginx.conf can forbid inline scripts.
ENV INLINE_RUNTIME_CHUNK=false
RUN npm run build

# ---- Serve stage ----
FROM nginx:alpine

COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
