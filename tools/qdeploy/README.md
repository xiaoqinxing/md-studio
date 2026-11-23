# qdeploy CLI

一个与 [`qdeploy`](../..) 服务端协议兼容的极简部署客户端。它只做三件事：

1. 读取配置和 token
2. 把目录或单个文件打成 `tar.gz`
3. 带 `Authorization: Bearer <token>` 和 `X-Deploy-Meta` 流式 `POST` 到
   `/api/v1/sites/<name>/deploy`，打印返回的 URL

**不实现** SSH、Caddy 配置、DNS 修改或服务端解压逻辑。所有发布行为都由
`deployd` 完成。

## 安装

```bash
cd tools/qdeploy
npm link          # 之后可直接运行 qdeploy 或 deploy
```

不安装也可以直接运行：

```bash
node bin/qdeploy.mjs --help
```

要求 Node.js 18+，没有第三方依赖。

## 登录

```bash
qdeploy login --url https://deploy.li.qinxing.xyz
# token 会隐藏输入
```

配置写入 `~/.config/qdeploy/config.json`（`0600`）：

```json
{
  "url": "https://deploy.li.qinxing.xyz",
  "token": "<token>",
  "base_domain": "li.qinxing.xyz"
}
```

优先级：命令行参数 > 环境变量 > 配置文件。

环境变量：

```bash
QDEPLOY_URL
QDEPLOY_TOKEN
QDEPLOY_BASE_DOMAIN
QDEPLOY_CONFIG       # 自定义配置文件路径
QDEPLOY_INSECURE=1   # 仅调试：跳过 TLS 证书校验
```

## 部署

```bash
qdeploy ./dist --name demo
qdeploy deploy ./dist --name demo
qdeploy ./dist --name app --spa
qdeploy page.html --name landing
```

目录会递归打包，自动跳过：

- 目录：`.git*`、`node_modules`、`__pycache__`、`.venv`、`venv`、`.qdeploy`
- 文件：`.DS_Store`、`qdeploy.json`、`.env*`
- 符号链接

可选 `qdeploy.json`（放在源目录根目录，不会上传）：

```json
{
  "name": "raw-image",
  "domain": "raw-image.li.qinxing.xyz",
  "spa": false,
  "headers": {
    "X-Frame-Options": "DENY"
  },
  "rules": [
    {
      "path": ["/assets/*"],
      "headers": { "Cache-Control": "public, max-age=31536000, immutable" }
    }
  ]
}
```

优先级：

- `--name` > manifest `name` > 目录名 slug
- `--domain` > manifest `domain` > `<name>.<base_domain>`
- `--spa` > manifest `spa` > `false`

部署后默认会轮询 `result.url`（20 次，每次 1.5 秒）；TLS 证书尚未签发时只提示，
不算失败。CI 可用 `--no-verify` 跳过。

## 其他命令

```bash
qdeploy ls
qdeploy show demo
qdeploy rollback demo
qdeploy rollback demo --release 20261121T112238Z-068bfb52
qdeploy rm demo --yes
qdeploy open demo
qdeploy health
```

## 输出与退出码

```
URL:      https://demo.li.qinxing.xyz
site:     demo
release:  20261121T112238Z-068bfb52
size:     2.3 MiB
caddy:    reloaded
```

- `0` 成功
- `2` 配置、网络或 HTTP 错误
- `130` Ctrl-C

## 测试

```bash
npm test
```

测试使用本地 mock HTTP 服务，不会访问真实部署服务。
