# 聚合钱包调整

管理员钱包调整是聚合余额操作，而非单个资产持仓操作。正数增加 `currency/free`，保持旧 Koishi 插件的管理员加余额语义；负数只从当前可用货币持仓扣除，并复用结账的 `free`、`paid` 顺序。

后端在员工 API 和 integration API 提供同一 `wallet/adjustment` 端点。调整结果持久化持仓与流水，并返回调整前后可用余额；Bot 的 `/add` 和 `/del` 只调用 integration 端点，因此不会因某一类余额持仓不存在而失败。
