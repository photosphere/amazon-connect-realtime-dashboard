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

// ── 状态 ────────────────────────────────────────────────────
let pollingTimer = null;
let countdownTimer = null;
let secondsLeft = 15;
const agentNameCache = new Map();

function resolveAgentName(agentId) {
  return agentNameCache.get(agentId) || agentId;
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
  const metricHeaders = metricKeys.map(([, meta]) => `<th>${meta.label}</th>`).join("");
  const thead = `<tr><th>坐席</th><th>状态</th><th>持续时间</th><th>联系数</th>${metricHeaders}</tr>`;

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

// ── 后端 API 调用 ────────────────────────────────────────────
async function fetchDashboard(hours) {
  const res = await fetch(`/api/dashboard?hours=${hours}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "API 请求失败" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function loadCachedData() {
  try {
    const res = await fetch("/api/load-data");
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
      body: JSON.stringify(data),
    });
  } catch (err) {
    console.warn("保存 data.json 失败:", err);
  }
}

// ── 主流程 ───────────────────────────────────────────────────
function getConfig() {
  return {
    hours: parseInt(document.getElementById("cfg-hours").value) || 8,
    interval: Math.max(5, parseInt(document.getElementById("cfg-interval").value) || 15),
  };
}

async function fetchAndRender() {
  const cfg = getConfig();

  // 1. 先从缓存加载
  const cached = await loadCachedData();
  if (cached) {
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

  // 2. 调用后端 API
  setStatus("loading", "获取中...");
  try {
    const data = await fetchDashboard(cfg.hours);
    if (data.agentNames) {
      for (const [id, name] of Object.entries(data.agentNames)) {
        agentNameCache.set(id, name);
      }
    }
    renderAgentStatus(data.userDataList, data.metrics);
    await saveCachedData(data);
    setStatus("ok", "运行中");
    document.getElementById("last-updated").textContent = `上次更新: ${data.updatedAt}`;
    startCountdown(cfg.interval);
  } catch (err) {
    console.error(err);
    if (cached) {
      setStatus("error", "API 请求失败，显示缓存数据");
    } else {
      setStatus("error", "请求失败");
      renderError(err.message || "API 调用失败，请检查后端服务和配置");
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
