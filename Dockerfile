# The stv.tf voice bot: one small Node process.
FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# /data is a volume for the STVTF_STATE file (the channels the bot is in). The node user owns it,
# so the bot can write there.
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "--import", "./src/instrument.mjs", "src/bot.mjs"]
