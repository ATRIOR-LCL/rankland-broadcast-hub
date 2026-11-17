#!/bin/sh
# 跑一个用例若干次：sh run-case.sh <用例名> <次数> [stress.cjs 参数...]
# 结果写到 outputs/stress/<用例名>/<n>.jsonl，控制台输出写到同名 .log。
# 需要本目录下的 .token（测试 Hub 的 AUTH_TOKEN）；参数里须带 hub=。
#
# 默认 bench 跑在 docker bridge 容器里（IN_DOCKER=0 时直接在宿主机上跑）：
# 宿主机 eth0 上的 tc 对容器流量相当于独立路由器，不受本机 TCP Small Queues 影响。
# 容器内关闭 TSO/GSO，使 qdisc 里每个包都是 MTU 大小，netem 的 limit（按包计）才对应真实队列长度。
cd "$(dirname "$0")"
# NODE_DIR：Node（>= 16）的安装目录，默认取 PATH 上的 node
NODE_DIR=${NODE_DIR:-$(dirname "$(dirname "$(command -v node)")")}
IN_DOCKER=${IN_DOCKER:-1}
name=$1; runs=$2; shift 2
mkdir -p "outputs/stress/$name"
for i in $(seq 1 "$runs"); do
  out="outputs/stress/$name/$i"
  if [ "$IN_DOCKER" = 1 ]; then
    docker run --rm --privileged --pid=host --network bridge -v "$PWD":/bench -v "$NODE_DIR":/node:ro -w /bench \
      --entrypoint sh networkstatic/iperf3 -c '
        nsenter -t 1 -m -- ethtool -K eth0 tso off gso off gro off >/dev/null 2>&1
        /node/bin/node stress.cjs "$@"; code=$?
        chown -R '"$(id -u):$(id -g)"' outputs; exit $code' sh \
      token="$(cat .token)" tcCmd="nsenter -t 1 -m -n tc" "$@" out="$out.jsonl" > "$out.log" 2>&1
  else
    "$NODE_DIR/bin/node" stress.cjs token="$(cat .token)" "$@" out="$out.jsonl" > "$out.log" 2>&1
  fi
  echo "$name #$i exit=$? $(grep -o '"ok":[0-9]*,"failed":\[[^]]*\]' "$out.jsonl" | tail -1)"
  sleep 3
done
