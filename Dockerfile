# Next.js production image using `output: 'standalone'` (see next.config.ts).
# The standalone server bundles only the traced runtime deps, so the final
# image does not need a separate `npm install --omit=dev`.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json next.config.ts next-env.d.ts ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
# Standalone output: server.js + the traced node_modules subset.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY config.yaml ./
EXPOSE 3001
CMD ["node", "server.js"]
