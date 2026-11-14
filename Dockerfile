# The stv.tf voice bot: one small Node process.
FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# Where the channels it is in are kept (STVTF_STATE), a volume: the bot's own to write.
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "--import", "./src/instrument.mjs", "src/bot.mjs"]
