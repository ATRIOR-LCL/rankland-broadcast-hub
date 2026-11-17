#!/bin/sh
# 被测服务器资源采样：每 2 s 一行，写到 stdout。
# 用法：nohup timeout 7200 sh host-sampler.sh > /tmp/hub-bench/logs/host.log 2>&1 &
# 字段：时间 | docker stats（hub-stress*）| eth0 累计收/发字节 | vda 累计读/写扇区
while true; do
  ts=$(date +%s.%N | cut -c1-14)
  stats=$(docker stats --no-stream --format '{{.Name}}={{.CPUPerc}},{{.MemUsage}};' hub-stress hub-stress-nginx hub-stress-redis 2>/dev/null | tr '\n' ' ' | sed 's/ \/ [^;]*//g')
  net=$(awk '/eth0:/ {print $2, $10}' /proc/net/dev)
  disk=$(awk '$3 == "vda" {print $6, $10}' /proc/diskstats)
  echo "$ts | $stats| net $net | disk $disk"
  sleep 2
done
