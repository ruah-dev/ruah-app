FROM node:22-slim
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev
COPY dist ./dist
CMD ["node", "dist/main.js"]
