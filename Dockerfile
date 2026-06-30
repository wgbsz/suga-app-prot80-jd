FROM node:22-slim

WORKDIR /app

# pyagent.pyz 需要 Python 运行；procps/iproute2/net-tools 用于日志里的进程/端口诊断
RUN apt-get update     && apt-get install -y --no-install-recommends        python3        ca-certificates        procps        iproute2        net-tools     && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=80
EXPOSE 80
CMD ["node", "index.js"]
