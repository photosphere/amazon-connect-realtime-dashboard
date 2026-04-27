# Amazon Connect 坐席指标看板

实时展示 Amazon Connect 坐席指标的 Web 应用。采用**前后端分离架构**：前端只负责展示，AWS 凭证只在 Node.js 后端使用，不暴露给浏览器。

## 架构

```
浏览器（Vite 构建的前端）
    │
    │  GET /api/dashboard?hours=8
    ▼
Express 后端 (:3001) ── 读取 .env 凭证
    │
    │  AWS SDK for JavaScript v3
    ▼
Amazon Connect
```

前端代码里没有任何 AWS 凭证，所有敏感信息都在后端的 `.env` 文件中。

## 前置条件

- **Node.js >= 20**（推荐使用 [fnm](https://github.com/Schniz/fnm) 或 [nvm](https://github.com/nvm-sh/nvm) 管理版本）
- **npm**（随 Node.js 一起安装）
- **AWS 凭证**：需要具有以下权限的 IAM Access Key
  - `connect:GetMetricDataV2`
  - `connect:GetCurrentUserData`
  - `connect:ListUsers`
- **Amazon Connect 实例**：需要实例 ID 和对应的 AWS Account ID

## 安装

```bash
npm install
```

## 配置

在项目根目录创建 `.env` 文件（可复制 `.env.example` 作为模板）：

```bash
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=your-secret-here
AWS_ACCOUNT_ID=123456789012
CONNECT_INSTANCE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
PORT=3001
```

⚠️ **安全提示**：`.env` 已加入 `.gitignore`，**绝不要**提交到 Git 仓库。

## 运行

### 开发模式（前后端同时启动）

```bash
npm run dev
```

- 后端 API: `http://localhost:3001`
- 前端页面: `http://localhost:8080/agent_metrics.html`（会自动打开）

Vite 开发服务器会把 `/api/*` 请求代理到后端，所以前端直接调用 `/api/dashboard` 即可。

### 只启动后端

```bash
npm run dev:server
```

### 只启动前端

```bash
npm run dev:client
```

## 构建与生产部署

```bash
npm run build   # 打包前端到 dist/
npm start       # 以生产模式启动后端，自动托管 dist/ 静态文件
```

生产模式下只需要跑一个进程，访问 `http://localhost:3001/agent_metrics.html` 即可。

### 部署建议

由于应用需要后端代理 AWS 调用，**不能**作为纯静态网站部署到 S3。推荐部署方式：

- **EC2 / ECS / Fargate**：跑 Node.js 进程，用 ALB 或 CloudFront 做入口
- **AWS Lambda + API Gateway**：把 `server/index.js` 改造成 Lambda handler
- **App Runner / Elastic Beanstalk**：托管式部署 Node.js 应用

部署时通过平台的环境变量配置（而不是 `.env` 文件）注入 AWS 凭证，或者使用 IAM Role 让后端自动获取临时凭证（更推荐，无需管理密钥）。

## API 接口

后端暴露的接口（都是 GET 无需参数或简单 query）：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/dashboard?hours=8` | GET | 获取坐席实时状态 + 历史指标的聚合数据 |
| `/api/load-data` | GET | 加载上次缓存的 `data.json` |
| `/api/save-data` | POST | 保存当前数据到 `data.json`（降级显示用） |

## 项目结构

```
├── server/
│   └── index.js         # Express 后端，所有 AWS SDK 调用在这里
├── src/
│   └── main.js          # 前端逻辑（UI 渲染、轮询、调用后端 API）
├── agent_metrics.html   # 前端页面
├── vite.config.js       # Vite 构建配置（含 /api 代理）
├── .env                 # 后端凭证（本地开发用，不提交）
├── .env.example         # 环境变量模板
├── .gitignore
└── package.json
```

## 指标说明

看板展示两类指标：

- **历史指标**（`GetMetricDataV2`）：占用率、接听率、平均处理时长、处理总时长、在线总时长等
- **实时状态**（`GetCurrentUserData`）：坐席当前状态（Available / Offline / Busy 等）、状态持续时间、当前联系数

数据按配置的刷新周期（默认 15 秒）轮询更新。

<img width="1511" height="328" alt="Image" src="https://github.com/user-attachments/assets/3d0d8d68-1cda-4d27-b20b-cad57c7e4a77" />
