# Team Manager

Team Manager 是以“账号 + Workspace”为核心的 ChatGPT 运营后台。所有受管登录身份都是 `Account`；账号能否管理 Workspace，由活动的 owner/admin `WorkspaceMembership` 实时派生，不再存在账号类型。

## 开发前必读

1. [`AGENTS.md`](./AGENTS.md)：协作、Git、安全和运行数据边界。
2. [`CONTEXT.md`](./CONTEXT.md)：统一领域术语。
3. [`docs/core/seat-and-credential-model.md`](./docs/core/seat-and-credential-model.md)：账号、Workspace、席位和凭证规则。
4. [`docs/plans/unified-account-postgresql-refactor.md`](./docs/plans/unified-account-postgresql-refactor.md)：本次重构实施与验收台账。
5. [`docs/plans/account-operational-primary-plan-and-actions.md`](./docs/plans/account-operational-primary-plan-and-actions.md)：账号运营主套餐和共享操作实施计划。
6. [`docs/plans/operational-visibility-restoration.md`](./docs/plans/operational-visibility-restoration.md)：旧版运营可见性恢复和最终 UI 验收台账。
7. [`docs/guide/account-cleanup-and-refresh-sop.md`](./docs/guide/account-cleanup-and-refresh-sop.md)：账号、Workspace 刷新、封号清理和备用 owner 操作 SOP。

开始和结束任务时检查 `git status --short --branch`。

## 产品模型

- `AccountGroup`：稳定 ID 的结构化账号分组；账号恰好属于一个分组，重命名不改账号记录。
- `Account`：唯一受管 ChatGPT 登录身份，承载邮箱、备注、封号标记、GAM 引用、代理和当前 Session。
- `PersonalSpace`：账号一对一的个人空间，承载 Free、Go、Plus、Pro 5x、Pro 20x、个人支付摘要和个人设置。
- `Workspace`：独立 Team/Business 空间，承载成员、邀请、设置、订阅、账单、客户席位和 Team 订单；管理入口统一位于账号详情中。
- `WorkspaceMembership`：账号或远端成员在 Workspace 中的角色和席位事实。活动 owner/admin 关系产生“拥有可管理空间”能力。
- `WorkspaceCredential`：绑定 `Account × Workspace` 的 OAuth/PAT 凭证。JSON 正文是文件制品，PostgreSQL 只保存索引、哈希和状态。

一个账号可以管理多个 Workspace，也可以作为普通成员加入其他 Workspace。Workspace 不永久属于某个账号；进入账号详情后，以当前账号作为 Workspace 操作上下文，只有活动 owner/admin 关系可以执行空间级写操作。

## 功能

- 账号列表、单一分组、主套餐与运营条件筛选和账号详情；固定席位 Business 动态显示关系占用与订阅权益容量；URL 保存筛选与详情 Tab，账号列表弹窗使用本地状态以免轮询刷新干扰表单。
- GAM 负责注册、纳管、Profile、住宅代理和浏览器 Checkout；账号、个人空间与 Workspace 业务状态及支付方式管理由 Team Manager 直连上游处理。
- 住宅代理 SID 统一为 8 位字母或数字，由 GAM 自动生成；账号换 IP 和注册任务代理弹窗共用校验与随机按钮。上游 SID 变化不改变账号的稳定 HTTP 代理地址。
- Go、Plus、Pro 5x、Pro 20x 首次开通；Plus 可通过 Team Manager 直连升级到 Pro 5x 或 Pro 20x，其他付费套餐转换在对应上游合同验证前安全拒绝。
- 个人空间与 Workspace 都支持绑定、设置默认和移除支付方式，以及取消续费；完整卡号/CVC 只进入当前 Team Manager 请求中的无追踪 Stripe Transport，不写数据库、普通日志或 HTTP trace，支付写操作都在返回前复读上游状态。
- Business 创建新 Workspace，或升级账号当前可管理的既有 Workspace。
- 账号详情内切换 Workspace；成员与邀请合并显示，并可从 owner 行单选 Workspace 的首选管理账号；账单集中呈现订阅、续费、金额、计费席位、支付方式和发票，并可校验和应用现有 Workspace 优惠码；凭证严格按 `Account × Workspace` 显示。
- 客户联系方式、备注、价格、到期日和显式到期提醒开关合并显示在账号 Workspace 的成员与邀请列表；提醒默认开启，只有同时设置到期日的席位才进入提醒调度。
- Team 升级订单维护、逐渠道幂等的有限重试通知、包含明细与管理入口的客户席位到期任务，以及独立的席位概览和母号概览页面。
- OAuth/PAT 创建、替换、重新授权、号池排序与 CPA 原子投放。
- HTTP trace、rrweb、凭证与隔离制品的文件索引、结构化日志、rrweb 回放、哈希复核和保留生命周期；Web UI 不展示或下载正文。

个人 Memory 的 PATCH 写入协议已经验证；当前值读取在上游实测返回 405，因此界面保持三态未知，不把未知伪装为关闭。只有账号 Session 在专用编辑弹窗中完整显示和保存；其他 JSON 正文不进入 Web UI。已登录管理界面右下角常驻 rrweb 调试按钮，由管理员手动开始和结束录制；录制按本项目的私有管理边界保留完整输入原文，只通过可视化回放使用。

## 数据与安全边界

PostgreSQL 是结构化业务数据的唯一事实源。应用启动只检查 migration，存在未应用 migration 时拒绝启动。

以下正文保持文件存储，数据库只保存相对 `storageKey`、SHA-256、大小和元数据：

- 完整 HTTP trace；
- rrweb `json.gz` 录制；
- OAuth/PAT JSON 凭证。

运行目录中的旧 JSON/JSONL 只保留为迁移备份证据，不在新版运行路径读取。Session、Access Token 和秘密设置在写入 PostgreSQL 前使用应用密钥加密。源码仓库不得保存真实域名、IP、端口、账号、密钥、token、代理或部署路径。

## 技术栈

- pnpm workspace、TypeScript ESM；
- Hono / Node.js 后端；
- React、Ant Design、Vite 前端；
- PostgreSQL、Kysely、`pg`；
- HS256 JWT、bcrypt 管理员密码；
- curl_cffi sidecar 作为 ChatGPT Web 传输实现；
- GAM 负责密码、浏览器身份、代理租约和浏览器 Checkout；Team Manager 负责普通 ChatGPT/Stripe HTTP 业务请求。

## 目录

| 路径 | 作用 |
|---|---|
| `apps/server` | 统一 API、领域服务、Repository、migration 与文件制品 |
| `apps/web` | 账号内 Workspace 管理、订单、设置和公开席位页面 |
| `apps/curl-cffi-worker` | ChatGPT Web 请求转发 sidecar |
| `packages/shared` | 新版前后端共享合同与 Session 解析 |
| `docs` | 领域规则、操作手册、协议样本和实施计划 |

## VPS 生产启动

以下命令在 VPS 的 Bash 中执行，默认已安装 Docker Engine、Compose 插件（支持 `up --wait`）和 Git，当前用户有 Docker 操作权限。不需要在宿主机安装 Node、pnpm 或 Python。本节不包含 Docker 安装步骤。

### 准备源码和私有配置

首次部署先选择两个独立目录，运行目录必须在源码目录之外。真实路径和秘密只保存在 VPS，不提交到仓库：

```bash
read -r -p '源码目录（绝对路径）: ' TM_SOURCE_DIR
read -r -p '私有运行目录（绝对路径）: ' TM_DEPLOY_DIR
git clone --branch dev --single-branch https://github.com/uZIDADADA/team-manager.git "$TM_SOURCE_DIR"
cd "$TM_SOURCE_DIR"
install -d -m 700 "$TM_DEPLOY_DIR"
if [ ! -e "$TM_DEPLOY_DIR/config.yaml" ]; then
  cp config.example.yaml "$TM_DEPLOY_DIR/config.yaml"
fi
chmod 600 "$TM_DEPLOY_DIR/config.yaml"
```

已有源码时进入原目录，执行 `git switch dev`、`git pull --ff-only origin dev`；已有运行配置时继续使用原文件，不覆盖它。重新登录终端后，需要重新设置 `TM_SOURCE_DIR` 和 `TM_DEPLOY_DIR` 为实际路径。

编辑私有 `config.yaml`，按 [配置模板](./config.example.yaml) 填写：

| 字段 | 内容 |
|---|---|
| `server.dataEncryptionKey` | 独立随机 32 字节密钥，64 位 hex 或 base64 |
| `server.jwtSecret` | 独立随机密钥，至少 32 字符 |
| `admin.username` / `admin.password` | 后台用户名和密码，明文密码不超过 72 UTF-8 字节 |
| `database.password` | 独立随机数据库密码 |
| `transport.curlCffiToken` | 独立随机令牌，至少 32 位字母、数字、下划线或连字符 |

首次部署空实例时可以生成四个独立密钥，再分别填写到上表对应位置：

```bash
docker run --rm node:22-bookworm-slim node -e '
const { randomBytes } = require("node:crypto");
for (const key of ["dataEncryptionKey", "jwtSecret", "databasePassword", "curlCffiToken"])
  console.log(key + ": " + randomBytes(32).toString("hex"));
'
```

不要公开输出或重新生成已有数据的加密密钥。管理员明文密码在首次读取配置时自动转为 bcrypt。

GAM（GPT Account Manager）是独立的注册、浏览器 Profile 和代理管理服务，不是启动必需项。暂不连接时，将 `integrations.accountManager.baseUrls.compose` 与 `integrations.accountManager.token` 设为 `null`，保留其他集成字段。Team Manager 仍可管理已导入有效 Session 的账号；依赖 GAM 的功能暂不可用。

其余 Compose 内部地址和目录先保留模板值，尤其是 `server.webDistDirs.compose`、数据库地址和 worker 地址。应用只读取 YAML，不读取旧 `.env.example`。

### 启动和检查

```bash
cd "$TM_SOURCE_DIR"
./scripts/deploy.sh "$TM_DEPLOY_DIR" up
./scripts/deploy.sh "$TM_DEPLOY_DIR" ps
./scripts/deploy.sh "$TM_DEPLOY_DIR" logs --tail 100 team-manager
read -r -p 'config.yaml 中的 server.port: ' TM_APP_PORT
curl -fsS "http://127.0.0.1:$TM_APP_PORT/health"
```

`up` 会构建应用和 worker，校验配置，停止旧应用，等待 PostgreSQL 与 worker 健康，执行迁移，再启动应用并等待健康检查。迁移失败会停止后续启动；修复错误后重新执行 `up`。`/health` 返回包含 `"ok":true` 的 JSON 表示应用可响应，接着验证首页、登录和所需业务功能。

必须通过脚本启动：脚本从同一份 YAML 派生 Compose 所需配置，不能直接用裸 `docker compose up -d` 替代。前端由后端提供，不需要单独运行 Vite。

### Nginx 对外访问

如果 Nginx 安装在同一台 VPS 的宿主机上，在现有 HTTPS 站点的 `server` 块内配置以下内容；将 `<server.port>` 替换为私有 YAML 中的实际端口。这是模板片段，不能原样加载占位符：

```nginx
location / {
    proxy_pass http://127.0.0.1:<server.port>;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

前端页面和 `/api` 都通过同一个入口代理。域名解析到 VPS，Nginx 站点配置证书和 HTTPS，公网仅放通 Nginx 的 HTTP/HTTPS 入口及原有 SSH 端口。应用端口保持 Compose 的 `127.0.0.1` 绑定，不必额外开放公网访问；PostgreSQL 和 worker 也不发布公网端口。

修改宿主机 Nginx 配置后校验并重载：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

如果 Nginx 运行在另一个容器里，其 `127.0.0.1` 指向 Nginx 容器自身，以上地址不适用；需将 Nginx 接入应用的 Docker 网络，使用应用服务名和容器端口作为上游。当前登录限流仍按实际 socket 来源计数，不信任转发头，代理后的访问会共享来源配额。代理指令参考 [Nginx 官方文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)。

### 更新、日志和停止

更新前按 [备份与恢复说明](./docs/guide/vps-deployment.md#备份、搬迁与恢复) 联合备份数据库、私有配置及文件制品，再执行：

```bash
cd "$TM_SOURCE_DIR"
git pull --ff-only origin dev
./scripts/deploy.sh "$TM_DEPLOY_DIR" up
./scripts/deploy.sh "$TM_DEPLOY_DIR" db-status
```

以下命令按需执行：

```bash
# 持续查看日志，Ctrl+C 退出日志查看，不停止服务
./scripts/deploy.sh "$TM_DEPLOY_DIR" logs -f --tail 100 team-manager
# 停止服务，保留数据
./scripts/deploy.sh "$TM_DEPLOY_DIR" stop
# 删除容器和网络，保留数据库卷及运行目录
./scripts/deploy.sh "$TM_DEPLOY_DIR" down
```

重新启动使用同一个 `up` 命令。升级继续使用原 `config.yaml`，不重新生成加密密钥；单实例升级在执行迁移时会短暂停机。完整目录约束、外部集成和备份流程见 [VPS 部署手册](./docs/guide/vps-deployment.md)。

## 开发与验证

运行配置的唯一事实源是部署目录的 `config.yaml`，结构参考 [`config.example.yaml`](./config.example.yaml)。管理员密码可以在首次迁移时填写明文，配置加载器会在跨进程锁内将其原子改写为 bcrypt cost 12；源码目录不读取 `.env`。本机完整开发实例通过部署目录的 `./tmux-dev-manager.sh` 管理。

配置 curl-cffi worker 时，必须在私有 `config.yaml` 的 `transport.curlCffiToken` 填写独立随机令牌（至少 32 位 URL-safe 字符，可用 `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'` 生成）。后端从 YAML 读取，配置启动器将同一值派生为 worker 的 `TEAMMGR_CURL_CFFI_TOKEN`；自定义 Compose 启动器也必须传入此变量。缺少或无效令牌时拒绝启动，错误令牌请求返回 401。升级已有部署时先补配置，再一起更新后端和 worker，重新启动这两个进程；不要复用管理员令牌或把 worker 端口公开。worker 只请求配置允许的上游 origin，并将 3xx 原样返回，不自动跟随重定向。

登录入口按实际 socket 来源限制为每分钟 10 次、每进程每分钟 60 次，最多同时处理 2 个登录请求且同一来源最多 1 个。连续失败达到 3 次后，从 1 秒开始指数退避，最多等待 60 秒；429 响应包含 `Retry-After`，被拒绝的重试不会延长冷却。成功登录清除失败退避，15 分钟无已接纳尝试后清除来源记录；登录请求体限制为 4 KiB，并在 5 秒内完成读取。限流不信任 `X-Forwarded-For` 等请求头，反向代理后的访问会共用代理 socket 来源配额。计数保存在当前进程内，重启会清空，多实例部署仍应在可信入口配置共享限流。

Vite 开发服务只监听 `127.0.0.1`，并使用默认 Host 白名单（localhost、其子域和 IP 地址），不接受任意域名。远程开发通过 SSH 端口转发后使用本机地址访问；生产使用构建后的静态文件。开发安全检查可运行 `corepack pnpm --filter @team-manager/web test:security`，会短暂启动回环地址上的测试服务。

前端的产品级组件行为集中维护：`theme/uiPolicy.ts` 负责弹层容器、视口边界、虚拟滚动和分页数量选择器，`theme/popupPolicy.css` 只保存全局弹层定位兜底；声明式弹窗/抽屉使用 `ProductModal`、`ProductDrawer`，业务日期输入使用支持整段粘贴和快捷项的 `ProductDatePicker`，非 Table 分页使用 `ProductPagination`，所有分页状态使用 `useUrlPagination`。页面可以直接使用 Ant Design `Select` 传递业务选项，但不得自行设置弹层容器、定位、动画、虚拟滚动或分页数量选择器策略。`theme/uiPolicy.test.ts` 会阻止这些旁路重新进入源码。

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm typecheck
corepack pnpm --filter @team-manager/server test
TEAMMGR_TEST_ADMIN_DATABASE_URL=postgresql://... corepack pnpm --filter @team-manager/server test:db
corepack pnpm --filter @team-manager/web test -- --run
corepack pnpm build
corepack pnpm docs:build
```

数据库命令：

```bash
corepack pnpm --filter @team-manager/server db:status
corepack pnpm --filter @team-manager/server db:migrate
```

生产 PostgreSQL、加密密钥和文件制品目录必须按同一恢复点备份并联合验证。业务操作只能经 UI、API 或 service/repository 完成，不直接编辑运行数据。

## 文档

- [使用手册](./docs/guide/)
- [账号、Workspace、席位与凭证模型](./docs/core/seat-and-credential-model.md)
- [PostgreSQL 数据模型](./docs/dev-spec/data-model.md)
- [账号运营主套餐和共享操作计划](./docs/plans/account-operational-primary-plan-and-actions.md)
- [运营可见性恢复实施计划](./docs/plans/operational-visibility-restoration.md)
- [固定 GPT 席位自助管理计划](./docs/plans/fixed-gpt-seat-self-service-management.md)
- [Team 升级订单维护](./docs/guide/team-order-maintenance.md)
- [凭证号池填充](./docs/guide/fill-credential-pool.md)
- [ChatGPT Web 协议样本](./docs/dev-spec/chatgpt-backend-api/README.md)
