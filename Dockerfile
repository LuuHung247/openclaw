FROM node:22-bookworm

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
