# Amazon Connect 坐席指标看板

浏览器端实时展示 Amazon Connect 坐席指标的单页应用，使用 AWS SDK for JavaScript v3 调用 `GetMetricDataV2` 和 `ListUsers` API。

## 前置条件

- **Node.js >= 20**（推荐使用 [fnm](https://github.com/Schniz/fnm) 或 [nvm](https://github.com/nvm-sh/nvm) 管理版本）
- **npm**（随 Node.js 一起安装）
- **AWS 凭证**：需要具有 `connect:GetMetricDataV2` 和 `connect:ListUsers` 权限的 IAM Access Key
- **Amazon Connect 实例**：需要实例 ID 和对应的 AWS Account ID

## 安装

```bash
npm install
```

## 运行（开发模式）

```bash
npm run dev
```

浏览器会自动打开 `http://localhost:8080/agent_metrics.html`。

## 配置

### 方式一：页面手动输入

在页面上填写 AWS 区域、Connect 实例 ID、Account ID，展开「AWS Credential 配置」填写 Access Key ID 和 Secret Access Key，点击「启动」。

### 方式二：config.json 自动加载

在项目根目录创建 `config.json`，页面加载时会自动读取并填入表单：

```json
{
  "accessKeyId": "AKIA...",
  "secretAccessKey": "your-secret-key",
  "accountId": "123456789012",
  "instanceId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

## 构建（生产部署）

```bash
npm run build
```

产物输出到 `dist/` 目录。

### 部署到 S3 + CloudFront

1. 执行 `npm run build` 生成 `dist/` 目录
2. 将 `dist/` 下所有文件上传到 S3 存储桶
3. 如需自动加载默认配置，将 `config.json` 也上传到 S3 存储桶根目录
4. 配置 CloudFront 分发指向该 S3 存储桶
5. 通过 CloudFront 域名访问 `agent_metrics.html`

## 项目结构

```
├── agent_metrics.html   # 主页面
├── src/main.js          # 业务逻辑（AWS SDK 调用、渲染、轮询）
├── config.json          # 可选，默认凭证配置
├── vite.config.js       # Vite 构建配置
└── package.json
```
