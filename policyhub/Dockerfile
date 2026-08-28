FROM node:22-slim
WORKDIR /app

# Dependencies first, as their own layer, so a code change does not
# reinstall them.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Run as a person, not as root.
#
# The base image ships a `node` user for exactly this. Left as root, any
# flaw that reaches the shell inside the container reaches it as the
# superuser of that container — the difference between a bad afternoon
# and a very bad one. Ownership is handed over after the install, because
# npm needs to write to /app during the build and not afterwards.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
