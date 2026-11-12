# The stv.tf voice bot: one small Node process.
FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
CMD ["node", "src/bot.mjs"]
