FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=80
EXPOSE 80
CMD ["node", "index.js"]
