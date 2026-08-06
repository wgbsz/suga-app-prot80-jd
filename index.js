const express = require("express");
const axios = require("axios");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);

// =====================================================
// 80端口容器专用版
// - 不运行 cloudflared / Argo，避免 7844 出站超时
// - Xray 占用容器公网 80 端口
// - Express 只监听 127.0.0.1:3001，作为 / /health /sub 回落页面
// - 保留 Komari 探针
// - 节点只保留 WebSocket 类：VLESS-WS、VMess-WS、Trojan-WS
// =====================================================

const app = express();

// ====== 基础变量 ======
const UPLOAD_URL = process.env.UPLOAD_URL || "";
const PROJECT_URL = process.env.PROJECT_URL || "";
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || ""; // 推荐填平台公网域名，不带 https://
const AUTO_ACCESS = String(process.env.AUTO_ACCESS || "false").toLowerCase() === "true";
const FILE_PATH = process.env.FILE_PATH || ".tmp";
const SUB_PATH = process.env.SUB_PATH || "wgb";

// 容器公网端口：统一 80
const XRAY_PORT = Number(process.env.PORT || process.env.SERVER_PORT || 80);

// Express 内部回落端口，不对外暴露
const WEB_PORT = Number(process.env.WEB_PORT || 3001);

const UUID = process.env.UUID || "6b65a009-3406-4353-8566-6d76f36faeda";

// 哪吒变量，可不用
const NEZHA_SERVER = process.env.NEZHA_SERVER || "";
const NEZHA_PORT = process.env.NEZHA_PORT || "";
const NEZHA_KEY = process.env.NEZHA_KEY || "";

// 节点域名变量
// 优先级：PUBLIC_DOMAIN > PROJECT_URL解析出来的host > CFIP > Unknown
const CFIP = process.env.CFIP || PUBLIC_DOMAIN || "";
const CFPORT = Number(process.env.CFPORT || 443);
const NAME = process.env.NAME || "";

// ====== Komari 探针变量 ======
// 兼容 KOMARI_SERVER 和旧的 KOMARI_ENDPOINT
const KOMARI_AGENT_URL = process.env.KOMARI_AGENT_URL || "https://github.com/liveqte/komari-agent-webhost/releases/download/latest/pyagent.pyz";
const KOMARI_ENDPOINT = process.env.KOMARI_SERVER || process.env.KOMARI_ENDPOINT || "";
const KOMARI_TOKEN = process.env.KOMARI_TOKEN || "";
const KOMARI_ENABLE = String(process.env.KOMARI_ENABLE || "true").toLowerCase() !== "false";

if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
  console.log(`${FILE_PATH} is created`);
} else {
  console.log(`${FILE_PATH} already exists`);
}

function generateRandomName() {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const npmName = generateRandomName();
const webName = generateRandomName();
const phpName = generateRandomName();

const npmPath = path.join(FILE_PATH, npmName);
const phpPath = path.join(FILE_PATH, phpName);
const webPath = path.join(FILE_PATH, webName);
const komariPath = path.join(FILE_PATH, "pyagent.pyz");
const komariLogPath = path.join(FILE_PATH, "komari.log");
const xrayLogPath = path.join(FILE_PATH, "xray.log");
const subPath = path.join(FILE_PATH, "sub.txt");
const listPath = path.join(FILE_PATH, "list.txt");
const configPath = path.join(FILE_PATH, "config.json");

function safeQuote(s) {
  return String(s).replace(/"/g, '\\"');
}

async function sh(command) {
  return exec(command, { timeout: 120000, maxBuffer: 1024 * 1024 * 4 });
}

function isValidUUID(v) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(String(v || ""));
}

function stripProtocol(input) {
  try {
    if (!input) return "";
    if (/^https?:\/\//i.test(input)) return new URL(input).host;
    return String(input).replace(/^https?:\/\//i, "").replace(/\/$/, "");
  } catch (_) {
    return String(input || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
  }
}

function getNodeHost() {
  const fromPublic = stripProtocol(PUBLIC_DOMAIN);
  if (fromPublic) return fromPublic;

  const fromProject = stripProtocol(PROJECT_URL);
  if (fromProject) return fromProject;

  const fromCfip = stripProtocol(CFIP);
  if (fromCfip) return fromCfip;

  return "your-public-domain.example.com";
}

function cleanupOldFiles() {
  try {
    for (const f of fs.readdirSync(FILE_PATH)) {
      try {
        const fp = path.join(FILE_PATH, f);
        if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
      } catch (_) {}
    }
  } catch (_) {}
}

function deleteNodes() {
  try {
    if (!UPLOAD_URL || !fs.existsSync(subPath)) return;
    const raw = fs.readFileSync(subPath, "utf8");
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const nodes = decoded.split("\n").filter(x => /(vless|vmess|trojan):\/\//.test(x));
    if (!nodes.length) return;
    axios.post(`${UPLOAD_URL}/api/delete-nodes`, JSON.stringify({ nodes }), {
      headers: { "Content-Type": "application/json" }, timeout: 8000
    }).catch(() => null);
  } catch (_) {}
}

async function generateConfig() {
  if (!isValidUUID(UUID)) {
    console.error(`UUID format error: ${UUID}. Please set Env Var UUID to a full UUID.`);
  }

  const config = {
    log: { access: "/dev/null", error: xrayLogPath, loglevel: "warning" },
    inbounds: [
      {
        port: XRAY_PORT,
        listen: "0.0.0.0",
        protocol: "vless",
        settings: {
          clients: [{ id: UUID }],
          decryption: "none",
          fallbacks: [
            { path: "/vless-argo", dest: 3002 },
            { path: "/vmess-argo", dest: 3003 },
            { path: "/trojan-argo", dest: 3004 },
            { dest: WEB_PORT }
          ]
        },
        streamSettings: { network: "tcp", security: "none" }
      },
      {
        port: 3002,
        listen: "127.0.0.1",
        protocol: "vless",
        settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false }
      },
      {
        port: 3003,
        listen: "127.0.0.1",
        protocol: "vmess",
        settings: { clients: [{ id: UUID, alterId: 0 }] },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vmess-argo" } },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false }
      },
      {
        port: 3004,
        listen: "127.0.0.1",
        protocol: "trojan",
        settings: { clients: [{ password: UUID }] },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false }
      }
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    outbounds: [{ protocol: "freedom", tag: "direct" }, { protocol: "blackhole", tag: "block" }]
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Config generated, xray public listen port: ${XRAY_PORT}`);
  console.log(`Express fallback listen: 127.0.0.1:${WEB_PORT}`);
  console.log(`Current UUID=${UUID}`);
}

function getSystemArchitecture() {
  const arch = os.arch();
  return (arch === "arm" || arch === "arm64" || arch === "aarch64") ? "arm" : "amd";
}

function getFilesForArchitecture(architecture) {
  const base = architecture === "arm" ? [
    { fileName: webPath, fileUrl: "https://arm64.ssss.nyc.mn/web" }
  ] : [
    { fileName: webPath, fileUrl: "https://amd64.ssss.nyc.mn/web" }
  ];

  if (NEZHA_SERVER && NEZHA_KEY) {
    if (NEZHA_PORT) {
      base.unshift({ fileName: npmPath, fileUrl: architecture === "arm" ? "https://arm64.ssss.nyc.mn/agent" : "https://amd64.ssss.nyc.mn/agent" });
    } else {
      base.unshift({ fileName: phpPath, fileUrl: architecture === "arm" ? "https://arm64.ssss.nyc.mn/v1" : "https://amd64.ssss.nyc.mn/v1" });
    }
  }
  return base;
}

function downloadFile(fileName, fileUrl) {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(fileName);
    axios({ method: "get", url: fileUrl, responseType: "stream", timeout: 60000 })
      .then(res => {
        res.data.pipe(writer);
        writer.on("finish", () => {
          writer.close();
          console.log(`Download ${path.basename(fileName)} successfully`);
          resolve(fileName);
        });
        writer.on("error", err => {
          try { fs.unlinkSync(fileName); } catch (_) {}
          reject(err);
        });
      })
      .catch(err => reject(err));
  });
}

async function startKomariAgent() {
  if (!KOMARI_ENABLE) {
    console.log("Komari agent disabled, skip running");
    return;
  }
  if (!KOMARI_ENDPOINT || !KOMARI_TOKEN) {
    console.log("KOMARI_SERVER/KOMARI_ENDPOINT or KOMARI_TOKEN is empty, skip running");
    return;
  }

  try {
    await downloadFile(komariPath, KOMARI_AGENT_URL);
    await sh(`chmod 775 "${komariPath}" >/dev/null 2>&1 || true`);
    try { fs.writeFileSync(komariLogPath, ""); } catch (_) {}

    const endpoint = safeQuote(KOMARI_ENDPOINT);
    const token = safeQuote(KOMARI_TOKEN);
    const pyz = safeQuote(komariPath);
    const log = safeQuote(komariLogPath);
    const cmd = `(command -v python3 >/dev/null 2>&1 && nohup python3 "${pyz}" -e "${endpoint}" -t "${token}" >>"${log}" 2>&1 & ) || (command -v python >/dev/null 2>&1 && nohup python "${pyz}" -e "${endpoint}" -t "${token}" >>"${log}" 2>&1 & )`;
    await sh(cmd);
    console.log("Komari pyagent start command executed");

    setTimeout(async () => {
      console.log("===== Komari Check Start =====");
      try {
        const { stdout } = await sh(`ps -ef | grep -E "[p]yagent.pyz|[k]omari" || true`);
        console.log(stdout.trim() || "Komari process not found, pyagent may have exited");
      } catch (e) {
        console.log(`Komari process check failed: ${e.message}`);
      }
      try {
        if (fs.existsSync(komariLogPath)) {
          const logTxt = fs.readFileSync(komariLogPath, "utf8").trim();
          console.log(logTxt ? logTxt.slice(-4000) : "Komari log is empty");
        } else {
          console.log("Komari log file not found");
        }
      } catch (e) {
        console.log(`Read Komari log failed: ${e.message}`);
      }
      console.log("===== Komari Check End =====");
    }, 8000);
  } catch (e) {
    console.error(`Komari start failed: ${e.message}`);
  }
}

async function startNezhaIfNeeded() {
  if (!(NEZHA_SERVER && NEZHA_KEY)) {
    console.log("NEZHA variable is empty, skip running");
    return;
  }
  try {
    if (!NEZHA_PORT) {
      const port = NEZHA_SERVER.includes(":") ? NEZHA_SERVER.split(":").pop() : "";
      const tlsPorts = new Set(["443", "8443", "2096", "2087", "2083", "2053"]);
      const nezhatls = tlsPorts.has(port) ? "true" : "false";
      const yaml = `client_secret: ${NEZHA_KEY}\ndebug: false\ndisable_auto_update: true\ndisable_command_execute: false\ndisable_force_update: true\ndisable_nat: false\ndisable_send_query: false\ngpu: false\ninsecure_tls: true\nip_report_period: 1800\nreport_delay: 4\nserver: ${NEZHA_SERVER}\nskip_connection_count: true\nskip_procs_count: true\ntemperature: false\ntls: ${nezhatls}\nuse_gitee_to_upgrade: false\nuse_ipv6_country_code: false\nuuid: ${UUID}`;
      fs.writeFileSync(path.join(FILE_PATH, "config.yaml"), yaml);
      await sh(`nohup "${phpPath}" -c "${FILE_PATH}/config.yaml" >/dev/null 2>&1 &`);
      console.log(`${phpName} is running`);
    } else {
      const tls = ["443", "8443", "2096", "2087", "2083", "2053"].includes(NEZHA_PORT) ? "--tls" : "";
      await sh(`nohup "${npmPath}" -s "${NEZHA_SERVER}:${NEZHA_PORT}" -p "${NEZHA_KEY}" ${tls} --disable-auto-update --report-delay 4 --skip-conn --skip-procs >/dev/null 2>&1 &`);
      console.log(`${npmName} is running`);
    }
  } catch (e) {
    console.error(`NEZHA running error: ${e.message}`);
  }
}

async function printXrayLogAndProcess() {
  console.log("===== Xray Check Start =====");
  try {
    const { stdout } = await sh(`ps -ef | grep -E "[${webName.charAt(0)}]${webName.slice(1)}|[x]ray|[v]2ray" || true`);
    console.log(stdout.trim() || "Xray process not found, it may have exited");
  } catch (e) {
    console.log(`Xray process check failed: ${e.message}`);
  }
  try {
    const { stdout } = await sh(`(ss -lntp || netstat -lntp || true) 2>/dev/null | grep -E ":(${XRAY_PORT}|3002|3003|3004|${WEB_PORT})\\b" || true`);
    console.log(stdout.trim() || `Listen ports not found`);
  } catch (e) {
    console.log(`Port check failed: ${e.message}`);
  }
  try {
    if (fs.existsSync(xrayLogPath)) {
      const txt = fs.readFileSync(xrayLogPath, "utf8").trim();
      console.log(txt ? txt.slice(-6000) : "xray.log is empty");
    } else {
      console.log("xray.log file not found");
    }
  } catch (e) {
    console.log(`Read xray log failed: ${e.message}`);
  }
  console.log("===== Xray Check End =====");
}

async function downloadFilesAndRun() {
  const arch = getSystemArchitecture();
  const files = getFilesForArchitecture(arch);
  try {
    await Promise.all(files.map(f => downloadFile(f.fileName, f.fileUrl)));
  } catch (e) {
    console.error(`Error downloading files: ${e.message}`);
    return;
  }

  const authFiles = NEZHA_PORT ? [npmPath, webPath] : [phpPath, webPath];
  for (const fp of authFiles) {
    if (fs.existsSync(fp)) {
      try { fs.chmodSync(fp, 0o775); console.log(`Empowerment success for ${fp}: 775`); } catch (e) { console.error(`Empowerment failed for ${fp}: ${e.message}`); }
    }
  }

  await startKomariAgent();
  await startNezhaIfNeeded();

  try {
    try { fs.writeFileSync(xrayLogPath, ""); } catch (_) {}
    await sh(`nohup "${webPath}" -c "${configPath}" >"${xrayLogPath}" 2>&1 &`);
    console.log(`${webName} start command executed, xray public port ${XRAY_PORT}`);
    setTimeout(() => printXrayLogAndProcess().catch(e => console.log(`Xray check failed: ${e.message}`)), 6000);
  } catch (e) {
    console.error(`web/xray running error: ${e.message}`);
  }
}

async function getMetaInfo() {
  try {
    const r = await axios.get("https://api.ip.sb/geoip", { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 3000 });
    if (r.data && r.data.country_code && r.data.isp) return `${r.data.country_code}-${r.data.isp}`.replace(/\s+/g, "_");
  } catch (_) {}
  try {
    const r = await axios.get("http://ip-api.com/json", { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 3000 });
    if (r.data && r.data.status === "success" && r.data.countryCode && r.data.org) return `${r.data.countryCode}-${r.data.org}`.replace(/\s+/g, "_");
  } catch (_) {}
  return "Unknown";
}

async function generateLinks() {
  const nodeHost = getNodeHost();
  const ISP = await getMetaInfo();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;

  const VMESS = {
    v: "2",
    ps: nodeName,
    add: nodeHost,
    port: String(CFPORT),
    id: UUID,
    aid: "0",
    scy: "auto",
    net: "ws",
    type: "none",
    host: nodeHost,
    path: "/vmess-argo?ed=2560",
    tls: "tls",
    sni: nodeHost,
    alpn: "",
    fp: "firefox"
  };

  const subTxt = `vless://${UUID}@${nodeHost}:${CFPORT}?encryption=none&security=tls&sni=${nodeHost}&fp=firefox&type=ws&host=${nodeHost}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}\n\nvmess://${Buffer.from(JSON.stringify(VMESS)).toString("base64")}\n\ntrojan://${UUID}@${nodeHost}:${CFPORT}?security=tls&sni=${nodeHost}&fp=firefox&type=ws&host=${nodeHost}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}\n`;

  const encoded = Buffer.from(subTxt).toString("base64");
  console.log("===== Subscription Base64 Start =====");
  console.log(encoded);
  console.log("===== Subscription Base64 End =====");
  fs.writeFileSync(subPath, encoded);
  fs.writeFileSync(listPath, subTxt.trim());
  console.log(`${subPath} saved successfully, nodeHost=${nodeHost}`);

  uploadNodes().catch(() => null);
  return subTxt;
}

async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    try {
      const subscriptionUrl = `${PROJECT_URL.replace(/\/$/, "")}/${SUB_PATH}`;
      const r = await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, { subscription: [subscriptionUrl] }, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
      if (r && r.status === 200) console.log("Subscription uploaded successfully");
    } catch (_) {}
  } else if (UPLOAD_URL && fs.existsSync(listPath)) {
    try {
      const content = fs.readFileSync(listPath, "utf8");
      const nodes = content.split("\n").filter(x => /(vless|vmess|trojan):\/\//.test(x));
      if (nodes.length) {
        const r = await axios.post(`${UPLOAD_URL}/api/add-nodes`, JSON.stringify({ nodes }), { headers: { "Content-Type": "application/json" }, timeout: 10000 });
        if (r && r.status === 200) console.log("Nodes uploaded successfully");
      }
    } catch (_) {}
  }
}

async function AddVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    console.log("Skipping adding automatic access task");
    return;
  }
  try {
    await axios.post("https://oooo.serv00.net/add-url", { url: PROJECT_URL }, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
    console.log("automatic access task added successfully");
  } catch (e) {
    console.error(`Add automatic access task failed: ${e.message}`);
  }
}

function printRuntimeDiagnostics() {
  setTimeout(async () => {
    console.log("===== Runtime Diagnostics Start =====");
    console.log(`XRAY_PORT=${XRAY_PORT}, WEB_PORT=${WEB_PORT}, NODE_HOST=${getNodeHost()}, UUID=${UUID}`);
    console.log(`KOMARI_ENDPOINT=${KOMARI_ENDPOINT}, KOMARI_ENABLE=${KOMARI_ENABLE}`);
    try {
      const { stdout } = await sh(`(ss -lntp || netstat -lntp || true) 2>/dev/null | grep -E ":(${XRAY_PORT}|${WEB_PORT}|3002|3003|3004)\\b" || true`);
      console.log(stdout.trim() || `No LISTEN info found`);
    } catch (e) {
      console.log(`Port check failed: ${e.message}`);
    }
    console.log("===== Runtime Diagnostics End =====");
  }, 12000);
}

async function startserver() {
  try {
    console.log(`Starting 80-port mode. Xray public port=${XRAY_PORT}, Express fallback=${WEB_PORT}`);
    console.log(`Node host=${getNodeHost()}, UUID=${UUID}`);
    deleteNodes();
    cleanupOldFiles();
    await generateConfig();
    await generateLinks();
    await downloadFilesAndRun();
    printRuntimeDiagnostics();
    await AddVisitTask();
  } catch (e) {
    console.error(`Error in startserver: ${e.stack || e.message}`);
  }
}

app.get("/", async (req, res) => {
  try {
    const indexPath = path.join(__dirname, "index.html");
    const data = await fs.promises.readFile(indexPath, "utf8");
    res.send(data);
  } catch (_) {
    res.send(`Hello world!<br><br>You can access /${SUB_PATH} to get your nodes!<br>XRAY_PORT=${XRAY_PORT}<br>WEB_PORT=${WEB_PORT}<br>UUID=${UUID}`);
  }
});

app.get(`/${SUB_PATH}`, (req, res) => {
  try {
    if (fs.existsSync(subPath)) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      res.send(fs.readFileSync(subPath, "utf8"));
    } else {
      res.status(404).send("subscription not generated yet");
    }
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/list", (req, res) => {
  try {
    if (fs.existsSync(listPath)) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      res.send(fs.readFileSync(listPath, "utf8"));
    } else {
      res.status(404).send("list not generated yet");
    }
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mode: "xray-80-no-argo",
    xrayPort: XRAY_PORT,
    webPort: WEB_PORT,
    nodeHost: getNodeHost(),
    cfport: CFPORT,
    uuid: UUID,
    subPath: `/${SUB_PATH}`,
    komariEndpointSet: Boolean(KOMARI_ENDPOINT),
    komariTokenSet: Boolean(KOMARI_TOKEN)
  });
});

app.listen(WEB_PORT, "127.0.0.1", () => {
  console.log(`Express fallback server is running on 127.0.0.1:${WEB_PORT}!`);
  startserver().catch(e => console.error(`Unhandled error in startserver: ${e.stack || e.message}`));
});
