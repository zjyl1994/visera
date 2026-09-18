# Visera

单用户的 IM 式 AI 绘图工作台。后端使用 Node.js + Express + SQLite，前端使用 React + Vite + MUI。

## 本地运行

复制示例配置并填入 OpenRouter Key；运行时只读取 TOML，不读取环境变量。

```bash
cp config.example.toml config.toml
chmod 600 config.toml
```

编辑 `config.toml` 中的 `[openrouter]`：

- `base_url` 支持 OpenRouter 或兼容网关；
- `api_key` 设置 OpenRouter Bearer Token；
- `[openrouter.headers]` 可配置任意额外请求 Header。

同时设置 `[auth]` 中的 `username` 和 `password`。配置文件包含登录凭据，必须保持 `0600` 权限。登录页可选择“记住我”：勾选后登录有效期为 30 天；未勾选时会在关闭浏览器后失效。

安装依赖并启动后端：

```bash
corepack pnpm install
corepack pnpm start -- --config config.toml
```

开发模式（API、前端静态模块和 HMR 均由同一个 Node 进程提供）：

```bash
corepack pnpm dev
```

浏览器访问 `http://127.0.0.1:8080`。生产静态资源可通过 `corepack pnpm build` 构建；Node 服务会自动提供 `web/dist` 中的前端文件。

首次切换到 Node 服务时请移除旧的 `data/visera.db`（或在 TOML 中指定新路径）。新服务会自动创建新的 SQLite schema，且不迁移旧 Go 数据库。
