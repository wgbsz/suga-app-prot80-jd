suga容器专用-----配置komari探针和节点输出
# 80端口容器版：Komari + WS节点输出，不跑 Argo

## 必填环境变量

```env
PORT=80
PUBLIC_DOMAIN=你的平台公网域名，不带 https://
UUID=你的UUID
KOMARI_SERVER=https://k.wgb.ccwu.cc
KOMARI_TOKEN=你的Komari探针Token
```

## 可选环境变量

```env
SUB_PATH=laow

NAME=你的节点名前缀
PROJECT_URL=https://你的平台公网域名
```

## 平台端口

```text
Private Networking Port: 80
Public Networking Port: 80
```

## 访问路径

```text
/health
/laow
/list
```

## 注意

这个版本不运行 cloudflared / Argo，因为当前容器平台出站 Cloudflare 7844 会超时。
