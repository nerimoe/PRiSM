# 玩家页网络上报

玩家页用真实的手机网络访问平台，这个情况从别的地方测不出来，所以由页面自己上报。平台看这份数据，决定店铺是否需要换接入线路。

## 记录什么

`page_reports` 每次访问一行，访问过程中更新（按访问 ID 覆盖，不会重复）：打开页面耗时、文档和接口的建连耗时、读取和操作的次数、网络失败次数和耗时、WebSocket 建连耗时和断开次数。网络信息来自 Cloudflare：ASN、运营商名称、国家、接入节点。

**不记录**玩家账号、卡片和 IP。数据保留 30 天，由定时任务清理。

## 怎么上报

- `POST /api/v1/devices/report`，只带资源的公开 ID，按 IP 限流。票据可能已过期，打开失败的访问也要能报，所以不要求登录。
- 打开 20 秒后、切到后台、离开页面时各发一次。
- 没发出去的留在手机上，下次访问一起发，最多留 5 条。这份数据最在意的正是网络差的时候，不能发不出去就丢。
- 失败指请求没有得到任何响应。平台返回的错误（比如 409）算请求成功到达。

## 看不到的

- **连网页都没打开的访问**：JS 都没下载下来时，上报代码也没有运行。所以真实情况只会比数据更差。
- **App Clip**：目前只有网页上报，App Clip 跟随下一版发布加入（`client` 为 `clip`）。

## 怎么判断

`wrangler d1 execute DB --remote --command "..."` 执行：

```sql
-- 按运营商看：访问数、打开失败率、打开耗时的 90 分位
SELECT asn, as_organization, n, failed,
       (SELECT open_ms FROM page_reports p WHERE p.asn IS g.asn AND open_ms IS NOT NULL
        ORDER BY open_ms LIMIT 1 OFFSET CAST(g.opened * 0.9 AS INTEGER)) AS open_p90_ms,
       read_failure_percent, action_failure_percent
FROM (
  SELECT asn, as_organization, COUNT(*) AS n, SUM(open_failed) AS failed,
         COUNT(open_ms) AS opened,
         ROUND(100.0 * SUM(read_failures) / MAX(SUM(reads), 1), 1) AS read_failure_percent,
         ROUND(100.0 * SUM(action_failures) / MAX(SUM(actions), 1), 1) AS action_failure_percent
  FROM page_reports WHERE reported_at > datetime('now', '-7 days') GROUP BY asn
) g ORDER BY n DESC;
```

暂定标准：某个主要运营商打开耗时的 90 分位超过 5 秒，或请求失败率超过 5%，就要考虑换线路（优选 IP，不行再上中转）。样本太少时不要下结论。
