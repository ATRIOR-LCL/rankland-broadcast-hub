# 精彩回放上传 + 推流联合压测

验证选手端在推流的同时上传精彩回放时：

1. 上传用什么限速策略和分块大小，才不挤占推流；
2. Hub（经 nginx）能同时承受多少路分块上传，瓶颈在哪里。

推流不经过 mediasoup，用 UDP 包模拟 WebRTC 视频的发包形态，只测网络层的带宽争用。产物写到仓库根目录的 `outputs/`（已 gitignore）。

## 拓扑

需要两台机器：

- **被测服务器**：运行测试 Hub、测试 nginx、测试 Redis（都在 docker 里）和 UDP 回显。
- **压测机**：运行推流 mock、选手 mock 与上传 mock，用 tc 在出口上模拟选手的上行带宽、时延和路由器队列。

```
压测机                                                被测服务器
  tc：只对目的地址为被测服务器的流量整形
  └─ stress.cjs（单进程）
       ├─ 推流 mock：N 路 UDP ───────────────────────► udp-echo.py（UDP 49990）
       ├─ 选手 mock：socket.io /broadcaster ──┐
       └─ 上传 mock：M 路 PATCH 分块上传 ─────┴──────► 测试 nginx（49992，TLS）
                                                          └─► hub-stress:3099 ── hub-stress-redis
```

两台机器之间需要放行 TCP 49992（可选 49993）与 UDP 49990。

## 文件

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `stress.cjs` | 压测机 | 选手 mock + 上传 mock + 推流 mock + 用例编排，参数见文件头 |
| `stream-mock.cjs` | 压测机 | 推流 mock：按帧发 UDP，统计上行丢包、RTT、抖动、帧完整率；可单独运行 |
| `run-case.sh` | 压测机 | 把一个用例跑若干次，默认在 docker 容器里跑（原因见「tc 与 TCP Small Queues」） |
| `summarize.cjs` | 任意 | 把 JSONL 结果汇总成 Markdown 表格，多次运行取中位数 |
| `ktb-control.cjs` | 压测机 | 用 KtB 原版 `HighlightService` 上传一次，校准上传 mock |
| `udp-echo.py` | 被测服务器 | UDP 回显，回包带该流的累计收包数，据此计算上行丢包 |
| `rl-api-mock.cjs` | 测试 Hub 容器 | RL API mock，选手 `u001`–`u100`，broadcasterToken 为 `bt-<userId>` |
| `nginx.stress.conf` | 测试 nginx 容器 | 由线上配置派生：49992 为 HTTP 反代（与线上一致）；49993 为 L4 TLS 直通，作为「无请求缓冲」的对照 |
| `host-sampler.sh` | 被测服务器 | 每 2 s 采样测试容器的 CPU/内存、网卡与磁盘 |

## 准备

### 测试媒体

上传用真实的 WebM，必须带 Duration（Hub complete 时会核对文件时长与元数据）：

```bash
mkdir -p outputs/stress-media && cd outputs/stress-media
for d in 30 60 120; do
  ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30,noise=alls=30:allf=t+u" -t $d \
    -c:v libvpx -deadline realtime -cpu-used 8 -b:v 10M -minrate 10M -maxrate 10M -bufsize 10M -g 60 -an \
    clip-${d}s-10M.webm
done
ffmpeg -i clip-30s-10M.webm -frames:v 1 -vf scale=320:-1 thumb.jpg
```

得到的 30 / 60 / 120 s 片段分别约 37 / 75 / 150 MB。

### 被测服务器

测试 Hub 复用线上镜像，把本地构建的 `app/` 挂载进去覆盖，不需要重新构建镜像。容器名统一以 `hub-stress` 开头，不使用 host 网络，与线上服务互不影响。

```bash
# 本地：构建并打包
pnpm run build
mkdir -p outputs/hub-bench/{bench,certs}
cp -r app outputs/hub-bench/
cp tests/bench/{rl-api-mock.cjs,udp-echo.py,host-sampler.sh,nginx.stress.conf} outputs/hub-bench/bench/
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=hub-stress \
  -keyout outputs/hub-bench/certs/stress.key -out outputs/hub-bench/certs/stress.crt
tar -C outputs -czf outputs/hub-bench.tgz hub-bench
# 把 hub-bench.tgz 传到被测服务器的 /tmp/

# 被测服务器
AUTH_TOKEN=$(openssl rand -hex 16)
mkdir -p /tmp/hub-bench && tar -C /tmp -xzf /tmp/hub-bench.tgz
mkdir -p /tmp/hub-bench/{data,logs,nginx-logs}
docker tag algoux/rankland-broadcast-hub:latest rankland-broadcast-hub:stress
docker network create hub-stress-net
docker run -d --name hub-stress-redis --network hub-stress-net --memory 256m redis:7-alpine \
  redis-server --save '' --appendonly no
docker run -d --name hub-stress --network hub-stress-net -p 127.0.0.1:3099:3099 \
  -v /tmp/hub-bench/app:/app/app:ro -v /tmp/hub-bench/bench:/bench:ro -v /tmp/hub-bench/data:/data \
  -e SERVER_HOST=0.0.0.0 -e SERVER_PORT=3099 -e AUTH_TOKEN=$AUTH_TOKEN \
  -e RL_API_URL=http://127.0.0.1:3100/api/v2 -e REDIS_HOST=hub-stress-redis \
  -e CLIP_STORAGE_DIR=/data -e CLIP_MAX_STORAGE_BYTES=3221225472 \
  --entrypoint sh rankland-broadcast-hub:stress -c 'node /bench/rl-api-mock.cjs 3100 & exec npm run deploy:foreground'
#   模拟受限部署时加 --cpus=1；CLIP_MAX_STORAGE_BYTES 要小于磁盘剩余空间
docker run -d --name hub-stress-nginx --network hub-stress-net -p 49992:49992 -p 49993:49993 \
  -v /tmp/hub-bench/bench/nginx.stress.conf:/etc/nginx/nginx.conf:ro \
  -v /tmp/hub-bench/certs:/etc/nginx/certs:ro -v /tmp/hub-bench/nginx-logs:/var/log/nginx nginx:stable
nohup timeout 21600 python3 /tmp/hub-bench/bench/udp-echo.py 49990 > /tmp/hub-bench/logs/echo.log 2>&1 &
echo $! > /tmp/hub-bench/echo.pid
```

`udp-echo.py` 用 `timeout` 启动，到点会退出，之后推流统计会变成 100% 丢包。长时间压测时注意时长，或按需重启。

### 压测机

需要 Node（>= 16；`ktb-control.cjs` 需要 >= 18）、docker 与 tc（iproute2），以及免密的 `sudo tc`。

```bash
mkdir -p ~/bench/media ~/bench/ktb && cd ~/bench
npm i socket.io-client@4
# 复制 tests/bench/*.cjs、run-case.sh → ~/bench/
# 复制 outputs/stress-media/* → ~/bench/media/
echo "$AUTH_TOKEN" > .token && chmod 600 .token
docker pull networkstatic/iperf3     # run-case.sh 的容器镜像，也用来测链路基线
```

先测一下两机之间的链路基线，确认出口带宽高于要模拟的选手上行：

```bash
# 被测服务器上临时起 iperf3 server：docker run -d --rm --name hub-stress-iperf -p 49991:5201/tcp -p 49991:5201/udp networkstatic/iperf3 -s
docker run --rm --network host networkstatic/iperf3 -c <hub-host> -p 49991 -t 15
docker run --rm --network host networkstatic/iperf3 -c <hub-host> -p 49991 -u -b 80M -l 1200 -t 8
```

## 运行

```bash
# 单选手：上行 C=45 Mbps、两路 10 Mbps 推流、60 s 片段，请求体内平滑限速到 C − 1.5S，跑 3 次
sh run-case.sh B3-smooth-k1.5-1M 3 hub=https://<hub-host>:49992 streams=2 mbps=10 pacingMs=100 players=1 \
  media=media/clip-60s-10M.webm chunk=1M pacing=smooth limit=k1.5 cap=45 tc=45,0,1000

node summarize.cjs outputs/stress
```

每次运行的流程：推流先单独跑 `pre` 秒作为基线 → 导播端建任务、选手上传 → 上传结束后推流再跑 `post` 秒。常用参数（完整列表见 `stress.cjs` 文件头）：

| 参数 | 含义 |
|---|---|
| `streams` / `mbps` / `pacingMs` | 推流路数、每路码率；`pacingMs` 把一帧的包摊到多少毫秒内发出（0 为整帧突发） |
| `players` / `items` | 模拟选手数、每名选手的任务数 |
| `chunk` | 分块大小，如 `256K`、`1M`、`4M` |
| `pacing` | `none` 不限速；`gap` 整块发出、块间等待；`smooth` 请求体内按 16 KiB 片段匀速写出 |
| `limit` / `cap` | `none`、固定 Mbps，或 `k<系数>`，表示 `cap − 系数 × 推流总码率`（不低于 `limitMin`，默认 2） |
| `tc` | `C,D,Q`：上行 Mbps、单程附加时延 ms、排队包数 |
| `outage` / `socketDrop` | `at,dur`：上传开始 `at` 秒后断网或断开 socket，持续 `dur` 秒 |
| `retry5xx` | 1 表示 5xx 也退避重试（KtB 现状为 0，收到 5xx 直接失败） |

### tc 与 TCP Small Queues

tc 如果直接整形压测机自己发出的 TCP，Linux 的 TCP Small Queues 会把 socket 在 qdisc 中的排队量限制在约 1 ms，上传填不满队列，测不出路由器的 bufferbloat。实测不限速上传时，推流 RTT 只涨约 6 ms、零丢包，与真实情况不符。

因此 `run-case.sh` 把 bench 放进 docker bridge 容器里运行：包经 veth 转发后不再受 TSQ 约束，宿主机 eth0 上的 tc 相当于一台独立的路由器。容器内关闭了 TSO/GSO，保证 netem 的 `limit`（按包计）对应真实的队列长度；`stress.cjs` 还会在 `limit` 上自动加上时延线里在途的包数。`IN_DOCKER=0` 时在宿主机上直接运行。

### 服务端本机容量

要排除网络因素、单独测 Hub 时，把上传 mock 放到被测服务器上与 Hub 同一个 docker 网络里运行（Hub 镜像里没有 socket.io-client，需要把压测机上的 `node_modules` 一起挂进去）：

```bash
docker run --rm --network hub-stress-net -v <bench 目录>:/bench -v <媒体目录>:/media -w /bench \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 --entrypoint node rankland-broadcast-hub:stress \
  stress.cjs hub=https://hub-stress-nginx:49992 token=$AUTH_TOKEN players=16 media=/media/clip-120s-10M.webm
```

把 `hub` 换成 `http://hub-stress:3099` 即为直连 Hub。

### 校准上传 mock

`ktb-control.cjs` 加载 KtB 的 `src/electron/services/highlight-service.ts`：先用 KtB 自带的 typescript（`ts.transpileModule`，CommonJS）转成 `ktb/highlight-service.js`，electron-log 由脚本自动替换成 stub。用它上传一次，再用 `stress.cjs`（`pacing=none chunk=1M`）上传同一个文件，对比每块耗时，确认两者行为一致。

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node ktb-control.cjs hub=https://<hub-host>:49992 token=$(cat .token) media=media/clip-60s-10M.webm
```

### 注意事项

- 用例之间建议清空测试 Hub 的数据目录：`docker stop hub-stress && rm -rf /tmp/hub-bench/data/* && docker start hub-stress`。Hub 刚重启时 socket 连接可能返回 502，等约 10 s 再开始。
- 压测机的交互 shell 如果是 zsh，`$VAR` 里的多个参数不会按空格拆开。批量用例写进 sh 脚本里运行。
- 每天结束前确认已删除 tc 规则：`sudo tc qdisc del dev eth0 root`。

## 清理

```bash
# 被测服务器
docker rm -f hub-stress hub-stress-redis hub-stress-nginx hub-stress-iperf
docker network rm hub-stress-net
docker rmi rankland-broadcast-hub:stress        # 只删标签，线上镜像不受影响
kill $(cat /tmp/hub-bench/echo.pid); rm -rf /tmp/hub-bench /tmp/hub-bench.tgz

# 压测机
sudo tc qdisc del dev eth0 root
```
