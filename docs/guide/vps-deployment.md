# VPS 部署

生产入口为仓库根目录的 `scripts/deploy.sh`。VPS 只需要 Bash、Docker Engine 和支持 `up --wait` 的 Docker Compose v2；Node、pnpm、Python 在镜像内运行。当前方案是一台 VPS 上的单实例部署，Compose 项目名固定为 `team-manager`。

服务包括 Team Manager（同时提供构建后的前端）、PostgreSQL 17 和 curl-cffi worker。数据库使用命名卷，文件制品与配置保存在源码之外的私有部署目录。数据库和 worker 不发布宿主机端口；应用只绑定宿主机回环地址，端口来自 `server.port`。生产不启动 Vite。

## 首次部署

将确定要上线的代码版本放到 VPS，并进入仓库根目录。本机未提交的修改不会随 `git clone` 自动到达 VPS。下面的命令在 Bash 中执行，部署目录由你指定，不能放在源码目录内：

```bash
read -r -p '私有部署目录（绝对路径）: ' TM_DEPLOY_DIR
install -d -m 700 "$TM_DEPLOY_DIR"
test ! -e "$TM_DEPLOY_DIR/config.yaml" && cp config.example.yaml "$TM_DEPLOY_DIR/config.yaml"
chmod 600 "$TM_DEPLOY_DIR/config.yaml"
```

编辑私有 `config.yaml`，替换以下值：

| 字段 | 要求 |
|---|---|
| `server.dataEncryptionKey` | 独立随机 32 字节密钥，填写 64 位 hex 或 base64 |
| `server.jwtSecret` | 独立随机密钥，至少 32 字符 |
| `admin.username` / `admin.password` | 管理员用户名和密码；明文密码不能超过 72 UTF-8 字节，首次读取会转换为 bcrypt |
| `database.password` | 独立随机数据库密码，必须替换示例值 |
| `transport.curlCffiToken` | 独立随机令牌，至少 32 位 URL-safe 字符 |

可以在 VPS 用下面的命令分别生成需要的密钥。输出是秘密，不要放到源码或公开日志中：

```bash
docker run --rm node:22-bookworm-slim node -e '
const { randomBytes } = require("node:crypto");
console.log("dataEncryptionKey: " + randomBytes(32).toString("hex"));
for (const key of ["jwtSecret", "databasePassword", "curlCffiToken"])
  console.log(key + ": " + randomBytes(32).toString("base64url"));
'
```

保留模板中的 Compose 内部地址：数据库指向 `postgres:5432`；worker 指向 `curl-cffi-worker`，URL 端口与 `deployment.worker.ports.compose` 保持一致。`server.webDistDirs.compose` 必须是 `/app/apps/web/dist`。`server.dataDir`、`server.artifactDir` 和 trace 路径使用配置目录内的相对路径，例如 `./data`、`./data/artifacts`。启动器会检查这些约束，避免将数据误写到未持久化的容器目录。

配置目录整体挂载到 `/runtime`，允许配置加载器创建锁文件并原子改写管理员密码。不要改为只读单文件挂载。`deployment.postgres.publishedPort` 仅供现有开发启动器使用，生产 Compose 不发布数据库端口。

按需要调整外部集成：

- 不连接 GAM 时，把 `integrations.accountManager.baseUrls.compose` 设为 `null`。需要 GAM 时填写容器可访问的地址和 token；本方案不部署 GAM，模板中的 `registrar-api` 也不会自动创建。
- 需要上游代理时填写 `deployment.worker.chatgptProxy`。容器中的 `127.0.0.1` 指容器本身；宿主机服务可通过 `host.docker.internal` 访问，但对应服务必须监听容器可达的接口。
- Stripe 等集成配置按实际功能填写。同源反向代理通常保留 `server.allowedOrigins: []`。

然后部署：

```bash
./scripts/deploy.sh "$TM_DEPLOY_DIR" up
./scripts/deploy.sh "$TM_DEPLOY_DIR" ps
./scripts/deploy.sh "$TM_DEPLOY_DIR" logs --tail 100 team-manager
```

`up` 依次构建应用镜像、读取并校验 YAML、构建 worker、停止旧应用、等待数据库与 worker 健康、执行一次性 migration、启动应用并等待 `/health` 成功。失败时立即退出；迁移失败不会重新启动应用，先查看错误并修复，再重新执行 `up`。首次构建需要联网拉取镜像和依赖。

应用运行设置仍然只来自 YAML。启动器在容器内复用配置加载器，将 Compose/worker 所需变量输出为临时 NUL 分隔记录，使用 Bash `read` / `export` 传递，不执行记录内容；临时文件权限为 600，使用后删除。不维护第二份 `.env`，也不要直接绕过启动器运行 `docker compose up`。

## HTTPS 与访问

将域名解析到 VPS，在宿主机配置 Caddy 或 Nginx，将请求反向代理到回环地址上的应用端口。只对公网开放 SSH 与 HTTP/HTTPS 所需端口，数据库和 worker 保持容器内访问。

Caddy 的私有配置可按下面结构填写；将占位符替换为自己的域名和 `server.port`，不要提交真实配置：

```text
<你的域名> {
    reverse_proxy 127.0.0.1:<server.port>
}
```

域名和端口配置正确后，Caddy 自动管理 HTTPS 证书。参见 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。若反向代理也运行在容器中，需要另行配置共享网络；该容器的 `127.0.0.1` 无法访问宿主机的应用端口。

通过域名检查 `/health`、首页和管理员登录，再验证一次需要的业务功能。`/health` 表示应用进程可响应，不代表 GAM、代理或所有上游功能都已验证。

## 更新与日常管理

更新前备份，将源码切换到确认要发布的版本，再运行相同的 `up` 命令。镜像构建失败时旧应用继续运行；构建完成后会短暂停机以执行迁移，单实例方案不提供无停机更新。

```bash
./scripts/deploy.sh "$TM_DEPLOY_DIR" up
./scripts/deploy.sh "$TM_DEPLOY_DIR" db-status
./scripts/deploy.sh "$TM_DEPLOY_DIR" logs -f --tail 100 team-manager
./scripts/deploy.sh "$TM_DEPLOY_DIR" stop
# 删除容器和网络，但保留数据库卷及私有部署目录
./scripts/deploy.sh "$TM_DEPLOY_DIR" down
```

数据库密码是数据库内部状态。PostgreSQL 官方镜像的初始化变量仅在空数据卷首次启动时生效；部署后只改 YAML 中的密码不会修改数据库用户密码。需要轮换时应先按数据库管理流程修改用户密码并同步配置。

PostgreSQL 主版本固定为 17，不要只修改镜像主版本后复用原数据卷。主版本升级需要单独的备份恢复或 `pg_upgrade` 流程。Compose 设置了自动重启和日志大小限制，但应用文件制品的容量、保留周期仍需要按实际使用管理。

## 备份、搬迁与恢复

必须在同一个停止写入窗口备份数据库、私有配置（含加密密钥）及文件制品。仅备份数据库或仅复制 `data` 都不足以恢复。不要把运行中的 PostgreSQL 卷目录直接当作可恢复备份。

下面示例通过应用停机、逻辑备份和目录归档建立同一恢复点。备份目录应在部署目录之外，并由你选择：

```bash
set -e
read -r -p '本次备份目录（部署目录之外）: ' TM_BACKUP_DIR
install -d -m 700 "$TM_BACKUP_DIR"
umask 077
# 停止应用，数据库保持运行
./scripts/deploy.sh "$TM_DEPLOY_DIR" stop team-manager
./scripts/deploy.sh "$TM_DEPLOY_DIR" exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$TM_BACKUP_DIR/database.dump"
tar -C "$TM_DEPLOY_DIR" -czf "$TM_BACKUP_DIR/runtime.tar.gz" .
./scripts/deploy.sh "$TM_DEPLOY_DIR" up
```

恢复时，在新实例的空数据库中恢复 dump，恢复同一备份的配置与文件目录，保留原 `dataEncryptionKey` 及版本，再执行迁移和启动。不要用新密钥替代已有密钥。代码回滚不等于数据库回滚；有不兼容 schema 变更时必须联合恢复同一备份点，并在隔离实例验证。

## 已知后续事项

仓库旧 `.env.example` 是历史模板，与当前 YAML 配置机制不一致；本部署入口不读取它，后续可单独清理或标记该历史文件。

## 部署代码验证

在有 Node 与项目依赖的开发环境执行：

```bash
node --test scripts/deploy.test.mjs
corepack pnpm --filter @team-manager/server exec tsx --test src/config.test.ts src/deployment.test.ts
corepack pnpm build
corepack pnpm docs:build
```

脚本测试使用模拟 Docker 命令验证停止、健康等待、迁移及失败退出顺序；真实容器的首次启动、数据库恢复和上游连通性仍需在有 Docker Engine 的环境验证。
