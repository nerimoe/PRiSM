# 通用操作租约

将结账专用的 `checkout_locks` 改为通用的 `operation_locks`。租约键由 `scope` 与 `resourceId` 组成，附带不可复用的 `lockId`、获取时间和过期时间。D1 用带过期条件的 `INSERT ... ON CONFLICT ... RETURNING` 原子抢占；释放必须同时匹配资源和 lockId。

本次只迁移会读取、计算并整体替换同一玩家资产持仓的流程到 `player.assets/<playerId>`：普通结账、改价结账、员工资产发放/调整、聚合钱包调整、兑换码发放资产与商品购买。抢锁失败统一返回 `OPERATION_IN_PROGRESS`；租约为 60 秒，`finally` 中释放。查询和设备命令不使用该锁。

`operation_locks` 的通用 scope 允许后续独立接入 `redeem-code/<codeId>`、`business-item/<itemId>` 等库存/使用次数资源，而不改变持久化接口。
