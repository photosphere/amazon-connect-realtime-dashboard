import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  ConnectClient,
  GetMetricDataV2Command,
  GetCurrentUserDataCommand,
  ListUsersCommand,
} from "@aws-sdk/client-connect";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || 3001;

// ── 从环境变量读取凭证（绝不通过 HTTP 暴露）──────────────────
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const CONNECT_INSTANCE_ID = process.env.CONNECT_INSTANCE_ID;

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_ACCOUNT_ID || !CONNECT_INSTANCE_ID) {
  console.error("❌ 缺少必要的环境变量，请检查 .env 文件");
  console.error("   需要: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ACCOUNT_ID, CONNECT_INSTANCE_ID");
  process.exit(1);
}

const client = new ConnectClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// ── 指标定义 ────────────────────────────────────────────────
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

// ── 工具函数 ────────────────────────────────────────────────
const agentNameCache = new Map();

async function listAllAgentIds() {
  const ids = [];
  let nextToken;
  do {
    const res = await client.send(
      new ListUsersCommand({
        InstanceId: CONNECT_INSTANCE_ID,
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

async function paginateMetrics(params) {
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

async function getAgentMetrics(agentIds, hours) {
  if (!agentIds?.length) return {};
  const endTime = new Date();
  const startTime = new Date(endTime - hours * 3600 * 1000);
  const resourceArn = `arn:aws:connect:${AWS_REGION}:${AWS_ACCOUNT_ID}:instance/${CONNECT_INSTANCE_ID}`;

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
      paginateMetrics({ ...baseParams, Metrics: AGENT_LEVEL_METRICS }),
      paginateMetrics({ ...baseParams, Metrics: AGENT_ONLY_METRICS }),
    ]);
    mergeResults(allResults, r1);
    mergeResults(allResults, r2);
  }
  return allResults;
}

async function getCurrentUserData() {
  const agentIds = await listAllAgentIds();
  if (!agentIds.length) return [];

  const allUserData = [];
  const BATCH = 100;
  for (let i = 0; i < agentIds.length; i += BATCH) {
    const batch = agentIds.slice(i, i + BATCH);
    let nextToken;
    do {
      const res = await client.send(
        new GetCurrentUserDataCommand({
          InstanceId: CONNECT_INSTANCE_ID,
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

// ── Express app ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));

// 聚合接口：前端一次拿到所有需要的数据
app.get("/api/dashboard", async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 8));
    const userDataList = await getCurrentUserData();
    const agentIds = userDataList.map((u) => u.User?.Id).filter(Boolean);
    const metrics = await getAgentMetrics(agentIds, hours);
    const agentNames = Object.fromEntries(agentNameCache);
    res.json({
      userDataList,
      metrics,
      agentNames,
      updatedAt: new Date().toLocaleTimeString("zh-CN"),
    });
  } catch (err) {
    console.error("Dashboard API error:", err);
    res.status(500).json({ error: err.message });
  }
});

// data.json 持久化（保留原有功能）
app.post("/api/save-data", (req, res) => {
  try {
    const filePath = path.join(ROOT, "data.json");
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), "utf-8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/load-data", (req, res) => {
  try {
    const filePath = path.join(ROOT, "data.json");
    if (!fs.existsSync(filePath)) return res.json(null);
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 生产环境直接托管 dist/
if (process.env.NODE_ENV === "production") {
  const distPath = path.join(ROOT, "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "agent_metrics.html"));
  });
}

app.listen(PORT, () => {
  console.log(`✅ API 服务已启动: http://localhost:${PORT}`);
  console.log(`   Connect 实例: ${CONNECT_INSTANCE_ID}`);
  console.log(`   区域: ${AWS_REGION}`);
});
