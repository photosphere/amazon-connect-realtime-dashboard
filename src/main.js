import {
  ConnectClient,
  GetMetricDataV2Command,
  GetCurrentUserDataCommand,
  ListUsersCommand,
} from "@aws-sdk/client-connect";

// ── 指标元数据 ──────────────────────────────────────────────
const METRIC_LABELS = {
  AGENT_OCCUPANCY:              { label: "占用率",         unit: "%",  highlight: true },
  AGENT_ANSWER_RATE:            { label: "接听率",         unit: "%",  highlight: true },
  AGENT_NON_RESPONSE:           { label: "未响应次数",     unit: "次", warn: true },
  AVG_HANDLE_TIME:              { label: "平均处理时长",   unit: "秒" },
  AVG_AFTER_CONTACT_WORK_TIME:  { label: "平均话后处理",   unit: "秒" },
  AVG_HOLD_TIME:                { label: "平均保持时长",   unit: "秒" },
  CONTACTS_HANDLED:             { label: "已处理联系数",   unit: "个" },
  CONTACTS_TRANSFERRED_OUT:     { label: "转出联系数",     unit: "个" },
  SUM_AFTER_CONTACT_WORK_TIME:  { label: "话后处理总时长", unit: "秒" },
  SUM_HANDLE_TIME:              { label: "处理总时长",     unit: "秒" },
  SUM_HOLD_TIME:                { label: "保持总时长",     unit: "秒" },
  SUM_INTERACTION_TIME:         { label: "交互总时长",     unit: "秒" },
  SUM_ONLINE_TIME_AGENT:        { label: "在线总时长",     unit: "秒", highlight: true },
  SUM_IDLE_TIME_AGENT:          { label: "空闲总时长",     unit: "秒" },
  SUM_NON_PRODUCTIVE_TIME_AGENT:{ label: "非生产总时长",   unit: "秒", warn: true },
  SUM_ERROR_STATUS_TIME_AGENT:  { label: "错误状态时长",   unit: "秒", warn: true },
  SUM_CONTACT_TIME_AGENT:       { label: "联系总时长",     unit: "秒" },
};

const AGENT_LEVEL_METRICS = [
  "AGENT_OCCUPANCY", "AGENT_ANSWER_RATE", "AGENT_NON_RESPONSE",
  "AVG_HANDLE_TIME", "AVG_AFTER_CONTACT_WORK_TIME", "AVG_HOLD_TIME",
  "CONTACTS_HANDLED", "CONTACTS_TRANSFERRED_OUT",
  "SUM_AFTER_CONTACT_WORK_TIME", "SUM_HANDLE_TIME", "SUM_HOLD_TIME", "SUM_INTERACTION_TIME",
].map((Name) => ({ Name }));

const AGENT_ONLY_METRICS = [
  "SUM_ONLINE_TIME_AGENT", "SUM_IDLE_TIME_AGENT",
  "SUM_NON_PRODUCTIVE_TIME_AGENT", "SUM_ERROR_STATUS_TIME_AGENT", "SUM_CONTACT_TIME_AGENT",
].map((Name) => ({ Name }));

// ── 状态 ────────────────────────────────────────────────────
let pollingTimer = null;
let countdownTimer = null;
let secondsLeft = 15;

// ── 坐席名称缓存 (Id → Username) ────────────────────────────
const agentNameCache = new Map();

// ── 创建 ConnectClient ──────────────────────────────────────
function makeClient(region, accessKeyId, secretAccessKey) {
  return new ConnectClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
}

// ── 获取全部坐席 ID（同时缓存 Username）─────────────────────
async function listAllAgentIds(client, instanceId) {
  const ids = [];
  let nextToken;
  do {
    const res = await client.send(
      new ListUsersCommand({
        InstanceId: instanceId,
        MaxResults: 100,
        ...(nextToken && { NextToken: nextToken }),
      })
    );
    for (const u of res.UserSummaryList ?? []) {
      if (u.Id) {
        ids.push(u.Id);
        if (u.Username) agentNameCache.set(u.Id, u.Username);
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return ids;
}

function resolveAgentName(agentId) {
  return agentNameCache.get(agentId) || agentId;
}

// ── GetMetricDataV2 分页 ─────────────────────────────────────
async function paginateMetrics(client, params) {
  const results = [];
  let nextToken;
  do {
    const res = await client.send(
      new GetMetricDataV2Command({
        ...params,
        MaxResults: 100,
        ...(nextToken && { NextToken: nextToken }),
      })
    );
    results.push(...(res.MetricResults ?? []));
    nextToken = res.NextToken;
  } while (nextToken);
  return results;
}

function mergeResults(target, metricResults) {
  for (const result of metricResults) {
    const agentId = result.Dimensions?.AGENT;
    if (!agentId) continue;
    if (!target[agentId]) target[agentId] = {};
    for (const col of result.Collections ?? []) {
      target[agentId][col.Metric.Name] = col.Value ?? null;
    }
  }
}

async function getAgentMetrics({ region, instanceId, accountId, accessKeyId, secretAccessKey, hours, agentIds }) {
  const client = makeClient(region, accessKeyId, secretAccessKey);
  if (!agentIds || !agentIds.length) return {};

  const endTime = new Date();
  const startTime = new Date(endTime - hours * 3600 * 1000);
  const resourceArn = `arn:aws:connect:${region}:${accountId}:instance/${instanceId}`;

  const BATCH = 100;
  const allResults = {};
  for (let i = 0; i < agentIds.length; i += BATCH) {
    const batch = agentIds.slice(i, i + BATCH);
    const baseParams = {
      ResourceArn: resourceArn,
      StartTime: startTime,
      EndTime: endTime,
      Filters: [{ FilterKey: "AGENT", FilterValues: batch }],
      Groupings: ["AGENT"],
    };
    const [r1, r2] = await Promise.all([
      paginateMetrics(client, { ...baseParams, Metrics: AGENT_LEVEL_METRICS }),
      paginateMetrics(client, { ...baseParams, Metrics: AGENT_ONLY_METRICS }),
    ]);
    mergeResults(allResults, r1);
    mergeResults(allResults, r2);
  }
  return allResults;
}

// ── 获取坐席实时状态 (GetCurrentUserData) ────────────────────
async function getCurrentUserData({ region, instanceId, accessKeyId, secretAccessKey }) {
  const client = makeClient(region, accessKeyId, secretAccessKey);
  const agentIds = await listAllAgentIds(client, instanceId);
  if (!agentIds.length) return [];

  const allUserData = [];
  const BATCH = 100;
  for (let i = 0; i < agentIds.length; i += BATCH) {
    const batch = agentIds.slice(i, i + BATCH);
    let nextToken;
    do {
      const res = await client.send(
        new GetCurrentUserDataCommand({
          InstanceId: instanceId,
          Filters: { Agents: batch },
          MaxResults: 100,
          ...(nextToken && { NextToken: nextToken }),
        })
      );
      allUserData.push(...(res.UserDataList ?? []));
      nextToken = res.NextToken;
    } while (nextToken);
  }
  return allUserData;
}

// ── UI 渲染 ──────────────────────────────────────────────────
function setStatus(type, text) {
  document.getElementById("status-dot").className = `status-dot ${type === "ok" ? "" : type}`;
  document.getElementById("status-text").textContent = text;
}

function renderError(msg) {
  const panel = document.getElementById("agent-status-panel");
  panel.style.display = "block";
  document.getElementById("agent-status-list").innerHTML = `<div class="error-state">⚠ ${msg}</div>`;
}

function getStatusBadgeClass(statusName) {
  if (!statusName) return "other";
  const s = statusName.toLowerCase();
  if (s === "available") return "available";
  if (s === "offline") return "offline";
  if (s === "busy" || s === "on contact" || s === "error") return "busy";
  return "other";
}

function formatDuration(startTimestamp) {
  if (!startTimestamp) return "N/A";
  const diff = Math.floor((Date.now() - new Date(startTimestamp).getTime()) / 1000);
  if (diff < 0) return "0s";
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function renderAgentStatus(userDataList, metrics) {
  const panel = document.getElementById("agent-status-panel");
  panel.style.display = "block";
  const container = document.getElementById("agent-status-list");

  if (!userDataList || !userDataList.length) {
    container.innerHTML = `<div class="status-empty">暂无在线坐席数据</div>`;
    return;
  }

  const metricKeys = Object.entries(METRIC_LABELS);

  // 表头：状态列 + 所有指标列
  const metricHeaders = metricKeys.map(([, meta]) => `<th>${meta.label}</th>`).join("");
  const thead = `<tr><th>坐席</th><th>状态</th><th>持续时间</th><th>联系数</th>${metricHeaders}</tr>`;

  // 表体
  const rows = userDataList.map((ud) => {
    const userId = ud.User?.Id ?? "N/A";
    const name = resolveAgentName(userId);
    const statusName = ud.Status?.StatusName ?? "Unknown";
    const badgeCls = getStatusBadgeClass(statusName);
    const duration = formatDuration(ud.Status?.StatusStartTimestamp);
    const contacts = (ud.Contacts ?? []).length;
    const agentMetrics = (metrics && metrics[userId]) || {};

    const metricCells = metricKeys.map(([key, meta]) => {
      const raw = agentMetrics[key];
      if (raw == null) return `<td class="metric-val na">N/A</td>`;
      const display = (Number.isInteger(raw) ? raw : raw.toFixed(2)) + " " + meta.unit;
      const cls = meta.highlight ? "metric-val highlight" : meta.warn ? "metric-val warn" : "metric-val";
      return `<td class="${cls}">${display}</td>`;
    }).join("");

    return `<tr>
      <td>${name}</td>
      <td><span class="status-badge ${badgeCls}">${statusName}</span></td>
      <td>${duration}</td>
      <td>${contacts}</td>
      ${metricCells}
    </tr>`;
  }).join("");

  container.innerHTML = `<table class="status-table">
    <thead>${thead}</thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── 倒计时 ───────────────────────────────────────────────────
function startCountdown(interval) {
  secondsLeft = interval;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    document.getElementById("countdown").textContent = `${--secondsLeft}s 后刷新`;
    if (secondsLeft <= 0) clearInterval(countdownTimer);
  }, 1000);
}

// ── data.json 持久化 ─────────────────────────────────────────
async function loadCachedData() {
  try {
    const res = await fetch("data.json?t=" + Date.now());
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function saveCachedData(data) {
  try {
    await fetch("/api/save-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data, null, 2),
    });
  } catch (err) {
    console.warn("保存 data.json 失败:", err);
  }
}

// ── 主流程 ───────────────────────────────────────────────────
function getConfig() {
  return {
    region: document.getElementById("cfg-region").value.trim(),
    instanceId: document.getElementById("cfg-instance-id").value.trim(),
    accessKeyId: document.getElementById("cfg-access-key").value.trim(),
    secretAccessKey: document.getElementById("cfg-secret-key").value.trim(),
    accountId: document.getElementById("cfg-account-id").value.trim(),
    hours: parseInt(document.getElementById("cfg-hours").value) || 8,
    interval: Math.max(5, parseInt(document.getElementById("cfg-interval").value) || 15),
  };
}

async function fetchAndRender() {
  const cfg = getConfig();
  if (!cfg.instanceId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.accountId) {
    renderError("请填写完整配置（实例 ID、Account ID 及 AWS Credential）");
    return;
  }

  // 1. 先从 data.json 加载缓存数据并立即渲染
  const cached = await loadCachedData();
  if (cached) {
    // 恢复坐席名称缓存
    if (cached.agentNames) {
      for (const [id, name] of Object.entries(cached.agentNames)) {
        agentNameCache.set(id, name);
      }
    }
    renderAgentStatus(cached.userDataList ?? [], cached.metrics ?? {});
    setStatus("ok", `显示缓存数据 (${cached.updatedAt ?? ""})`);
    document.getElementById("last-updated").textContent = cached.updatedAt
      ? `上次更新: ${cached.updatedAt}`
      : "";
  }

  // 2. 尝试从 API 获取最新数据
  setStatus("loading", "获取中...");
  try {
    const userDataList = await getCurrentUserData(cfg);
    const agentIds = userDataList
      .map((ud) => ud.User?.Id)
      .filter(Boolean);
    const metrics = await getAgentMetrics({ ...cfg, agentIds });

    // API 成功 → 渲染 + 保存 data.json
    renderAgentStatus(userDataList, metrics);

    const updatedAt = new Date().toLocaleTimeString("zh-CN");
    const agentNames = Object.fromEntries(agentNameCache);
    await saveCachedData({ userDataList, metrics, agentNames, updatedAt });

    setStatus("ok", "运行中");
    document.getElementById("last-updated").textContent = `上次更新: ${updatedAt}`;
    startCountdown(cfg.interval);
  } catch (err) {
    console.error(err);
    // API 失败 → 如果有缓存数据则保持显示，不覆盖
    if (cached) {
      setStatus("error", "API 请求失败，显示缓存数据");
    } else {
      setStatus("error", "请求失败");
      renderError(err.message || "API 调用失败，请检查配置和网络");
    }
    startCountdown(cfg.interval);
  }
}

function startPolling() {
  stopPolling();
  const interval = Math.max(5, parseInt(document.getElementById("cfg-interval").value) || 15);
  fetchAndRender();
  pollingTimer = setInterval(fetchAndRender, interval * 1000);
}

function stopPolling() {
  clearInterval(pollingTimer);
  clearInterval(countdownTimer);
  pollingTimer = null;
  document.getElementById("countdown").textContent = "";
  document.getElementById("agent-status-panel").style.display = "none";
  setStatus("", "已停止");
}

// ── 事件绑定 ─────────────────────────────────────────────────
document.getElementById("btn-start").addEventListener("click", startPolling);
document.getElementById("btn-stop").addEventListener("click", stopPolling);
document.getElementById("cred-toggle").addEventListener("click", () => {
  const toggle = document.getElementById("cred-toggle");
  const body = document.getElementById("cred-body");
  const isOpen = body.classList.toggle("open");
  toggle.classList.toggle("open", isOpen);
});

// ── 启动时加载 config.json ────────────────────────────────────
(async function loadConfig() {
  try {
    const res = await fetch("config.json");
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.accessKeyId) document.getElementById("cfg-access-key").value = cfg.accessKeyId;
    if (cfg.secretAccessKey) document.getElementById("cfg-secret-key").value = cfg.secretAccessKey;
    if (cfg.accountId) document.getElementById("cfg-account-id").value = cfg.accountId;
    if (cfg.instanceId) document.getElementById("cfg-instance-id").value = cfg.instanceId;
    console.info("已从 config.json 加载默认配置");
  } catch { /* 没有 config.json，使用手动输入 */ }
})();
