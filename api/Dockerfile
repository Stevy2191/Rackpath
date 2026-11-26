FROM node:24-alpine

# su-exec lets the entrypoint fix /uploads ownership as root and then run the
# API as the unprivileged "node" user.
RUN apk add --no-cache su-exec

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
# npm ci installs exactly the locked (audited) dependency versions.
RUN npm ci --omit=dev

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /uploads && chown node:node /uploads

ENV NODE_ENV=production
EXPOSE 3010

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
