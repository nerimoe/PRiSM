import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  ActionForm,
  Field,
  Modal,
  State,
  Table,
  button,
  cell,
  date,
  input,
  money,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
  type Asset,
  type LivePlayer,
  type Player,
  type Preview,
} from "./shared";

type Holdings = {
  holdings: {
    id: string;
    assetName: string;
    quantity: number;
    expiresAt: string | null;
  }[];
  ledgerEntries: {
    id: string;
    assetName: string;
    delta: number;
    reason: string;
    createdAt: string;
  }[];
};
type History = {
  sessions: {
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    total: number | null;
  }[];
};
export function Players({ live = false }: { live?: boolean }) {
  const { t } = useI18n();
  const { canWrite, shopCode } = useMerchant();
  const request = useStaffApi();
  const list = useResource<{ players: Player[] }>("players");
  const onSite = useResource<{ players: LivePlayer[] }>("live-players");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState(false);
  const [params, setParams] = useSearchParams();
  const selected = list.data?.players.find(
    (p) => p.id === params.get("player"),
  );
  const refresh = () => {
    list.reload();
    onSite.reload();
  };
  const rows = list.data?.players.filter(
    (player) =>
      (!live || onSite.data?.players.some((p) => p.playerId === player.id)) &&
      `${player.displayName} ${player.identities?.map((i) => i.subject).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-xl font-semibold">
          {t(live ? "在店玩家" : "玩家")}
          {rows && (
            <span className="ml-2 text-base font-normal text-ink/50">
              {rows.length}
            </span>
          )}
        </h2>
        <button className={button} onClick={refresh} aria-label={t("刷新")}>
          <RefreshCw size={16} />
        </button>
        {canWrite && (
          <button className={primary} onClick={() => setCreate(true)}>
            <Plus size={16} />
            {t("添加玩家")}
          </button>
        )}
      </div>
      <input
        className={`${input} max-w-md`}
        type="search"
        placeholder={t("搜索昵称或 QQ")}
        aria-label={t("搜索玩家")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {list.error || onSite.error ? (
        <State error={list.error || onSite.error} />
      ) : !rows || !onSite.data ? (
        <State />
      ) : !rows.length ? (
        <State empty />
      ) : (
        <>
          <div className="divide-y divide-ink/10 rounded-xl bg-panel md:hidden">
            {rows.map((player) => {
              const current = onSite.data?.players.find(
                (p) => p.playerId === player.id,
              );
              return (
                <button
                  key={player.id}
                  className="focus-ring grid w-full grid-cols-[1fr_auto] gap-2 p-4 text-left"
                  onClick={() => setParams({ player: player.id })}
                >
                  <span className="font-semibold">{player.displayName}</span>
                  <span className="tabular-nums">
                    {money(player.walletTotal)}
                  </span>
                  <span className="text-xs text-ink/50">
                    {
                      player.identities?.find((i) => i.provider === "qq")
                        ?.subject
                    }
                  </span>
                  <span className="text-right text-xs text-ink/50">
                    {t("余额")}
                  </span>
                  {current && (
                    <span className="col-span-2 mt-2 flex justify-between border-t border-ink/10 pt-3 text-sm text-ink/60">
                      <span>
                        {Math.floor(current.stayDurationMinutes)} {t("分钟")}
                      </span>
                      <span>
                        {t("预计消费")} {money(current.estimatedTotal)}
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="hidden md:block">
            <Table
              headers={[
                "玩家",
                "余额",
                ...(live ? ["时长", "预计消费"] : ["状态"]),
                "操作",
              ]}
            >
              {rows.map((player) => {
                const current = onSite.data?.players.find(
                  (p) => p.playerId === player.id,
                );
                return (
                  <tr key={player.id}>
                    <td className={cell}>
                      <button
                        className="focus-ring rounded text-left font-medium hover:underline"
                        onClick={() => setParams({ player: player.id })}
                      >
                        {player.displayName}
                      </button>
                      <p className="mt-1 text-xs text-ink/50">
                        {
                          player.identities?.find((i) => i.provider === "qq")
                            ?.subject
                        }
                      </p>
                    </td>
                    <td className={cell}>{money(player.walletTotal)}</td>
                    {live ? (
                      <>
                        <td className={cell}>
                          {Math.floor(current?.stayDurationMinutes ?? 0)}{" "}
                          {t("分钟")}
                        </td>
                        <td className={cell}>
                          {money(current?.estimatedTotal)}
                        </td>
                      </>
                    ) : (
                      <td className={cell}>
                        {t(
                          player.status !== "active"
                            ? "已停用"
                            : current
                              ? "在店"
                              : "正常",
                        )}
                      </td>
                    )}
                    <td className={cell}>
                      <button
                        className={button}
                        onClick={() => setParams({ player: player.id })}
                      >
                        {t("查看")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </div>
        </>
      )}
      {live && (
        <Link
          to={`/merchant/${shopCode}/players`}
          className="w-fit text-sm underline underline-offset-4"
        >
          {t("全部玩家")}
        </Link>
      )}
      {create && (
        <Modal title="添加玩家" close={() => setCreate(false)}>
          <ActionForm
            done={() => {
              setCreate(false);
              refresh();
            }}
            submit={async (form) => {
              await request("players", "POST", {
                displayName: form.get("name"),
              });
            }}
          >
            <Field label="昵称">
              <input className={input} name="name" required maxLength={80} />
            </Field>
          </ActionForm>
        </Modal>
      )}
      {selected && (
        <PlayerDetail
          key={selected.id}
          player={selected}
          current={onSite.data?.players.find((p) => p.playerId === selected.id)}
          close={() => setParams({})}
          refresh={refresh}
        />
      )}
    </div>
  );
}
function PlayerDetail({
  player,
  current,
  close,
  refresh,
}: {
  player: Player;
  current?: LivePlayer;
  close: () => void;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const { canWrite, shopCode } = useMerchant();
  const request = useStaffApi();
  const base = `players/${segment(player.id)}`;
  const assets = useResource<Holdings>(`${base}/assets`);
  const history = useResource<History>(`${base}/sessions/history`);
  const definitions = useResource<{ assetDefinitions: Asset[] }>(
    "asset-definitions",
  );
  const [action, setAction] = useState<
    "wallet" | "entry" | "checkout" | "identity" | "status" | "grant" | null
  >(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const done = () => {
    setAction(null);
    setPreview(null);
    assets.reload();
    history.reload();
    refresh();
  };
  async function checkout() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setPreview(
        await request<Preview>(`${base}/checkout/preview`, "POST", {}),
      );
      setAction("checkout");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={player.displayName} close={close}>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-sm text-ink/60">{t("余额")}</span>
        <strong className="text-3xl font-semibold tabular-nums">
          {money(player.walletTotal)}
        </strong>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-coral">
          {error}
        </p>
      )}
      {canWrite && (
        <div className="mb-5 flex flex-wrap gap-2">
          <button className={primary} onClick={() => setAction("wallet")}>
            {t("充值 / 扣款")}
          </button>
          <button
            className={button}
            disabled={busy || player.status !== "active"}
            onClick={() => (current ? checkout() : setAction("entry"))}
          >
            {t(current ? "结账" : "入场")}
          </button>
          <button className={button} onClick={() => setAction("grant")}>
            {t("发放资产")}
          </button>
        </div>
      )}
      {action === "wallet" && (
        <ActionForm
          done={done}
          label="确认调整"
          submit={(f) =>
            f.get("direction") === "minus"
              ? request(`${base}/wallet/adjustment`, "POST", {
                  amount: -Number(f.get("amount")),
                  reason: f.get("reason"),
                })
              : request(`${base}/assets/grants`, "POST", {
                  reason: f.get("reason"),
                  grants: [
                    {
                      assetType: "currency",
                      assetCode: f.get("account"),
                      amount: Number(f.get("amount")),
                      mergeStrategy: "stack",
                      activeAt: null,
                      expiresAt: null,
                    },
                  ],
                })
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="操作">
              <select className={input} name="direction">
                <option value="plus">{t("充值")}</option>
                <option value="minus">{t("扣款")}</option>
              </select>
            </Field>
            <Field label="金额">
              <input
                className={input}
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </Field>
          </div>
          <Field label="充值账户">
            <select
              className={input}
              name="account"
              required
              defaultValue="paid"
            >
              {definitions.data?.assetDefinitions
                .filter((a) => a.type === "currency" && a.status !== "archived")
                .map((a) => (
                  <option value={a.code} key={a.code}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="备注">
            <input className={input} name="reason" required maxLength={200} />
          </Field>
        </ActionForm>
      )}
      {action === "entry" && (
        <ActionForm
          done={done}
          label="确认入场"
          submit={() => request(`${base}/session/start`, "POST", {})}
        >
          <p className="text-sm">{t("按店铺入场规则开始计费。")}</p>
        </ActionForm>
      )}
      {action === "checkout" && preview && (
        <ActionForm
          done={done}
          label="确认结账"
          submit={() => request(`${base}/checkout/confirm`, "POST", {})}
        >
          <div className="divide-y divide-ink/10">
            {[...preview.chargeItems, ...preview.adjustments].map(
              (row, index) => (
                <p
                  key={index}
                  className="flex justify-between gap-3 py-2 text-sm"
                >
                  <span>{row.label}</span>
                  <span>{money(row.amount)}</span>
                </p>
              ),
            )}
          </div>
          <p className="flex justify-between text-xl font-semibold">
            <span>{t("合计")}</span>
            {money(preview.settlementPreview.total)}
          </p>
          <p className="text-sm text-ink/60">
            {t("结账后余额")} {money(preview.wallet.balanceAfter)}
          </p>
        </ActionForm>
      )}
      {action === "grant" && (
        <ActionForm
          done={done}
          label="确认发放"
          submit={(f) => {
            const [assetType, assetCode] = String(f.get("asset")).split("|");
            return request(`${base}/assets/grants`, "POST", {
              reason: f.get("reason"),
              grants: [
                {
                  assetType,
                  assetCode,
                  amount: Number(f.get("amount")),
                  mergeStrategy: "stack",
                  activeAt: null,
                  expiresAt: null,
                },
              ],
            });
          }}
        >
          <Field label="资产">
            <select name="asset" className={input} required>
              {definitions.data?.assetDefinitions
                .filter((a) => a.status !== "archived")
                .map((a) => (
                  <option
                    key={`${a.type}:${a.code}`}
                    value={`${a.type}|${a.code}`}
                  >
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="数量">
            <input
              className={input}
              type="number"
              name="amount"
              min="0.01"
              step="0.01"
              required
              defaultValue="1"
            />
          </Field>
          <Field label="备注">
            <input className={input} name="reason" required />
          </Field>
        </ActionForm>
      )}
      {action && (
        <button
          className={`${button} mt-3`}
          onClick={() => {
            setAction(null);
            setPreview(null);
          }}
        >
          {t("取消")}
        </button>
      )}
      <div className="mt-6 grid gap-5">
        <details open>
          <summary className="cursor-pointer py-2 font-medium">
            {t("资产")}
          </summary>
          {assets.error ? (
            <State error={assets.error} />
          ) : (
            assets.data?.holdings.map((h) => (
              <div
                key={h.id}
                className="flex justify-between gap-3 border-b border-ink/10 py-3 text-sm"
              >
                <span>
                  {h.assetName}
                  <small className="block text-ink/50">
                    {h.expiresAt && date(h.expiresAt)}
                  </small>
                </span>
                {h.quantity}
              </div>
            ))
          )}
        </details>
        <details>
          <summary className="cursor-pointer py-2 font-medium">
            {t("消费记录")}
          </summary>
          {history.data?.sessions.map((s) => (
            <div
              key={s.sessionId}
              className="flex justify-between gap-3 border-b border-ink/10 py-3 text-sm"
            >
              <span>{date(s.startedAt)}</span>
              <span>{s.endedAt ? money(s.total) : t("进行中")}</span>
            </div>
          ))}
          {history.error && <State error={history.error} />}
        </details>
        <details>
          <summary className="cursor-pointer py-2 font-medium">
            {t("资产流水")}
          </summary>
          {assets.data?.ledgerEntries.map((e) => (
            <div
              key={e.id}
              className="grid grid-cols-[1fr_auto] gap-1 border-b border-ink/10 py-3 text-sm"
            >
              <span>
                {e.assetName} · {e.reason}
              </span>
              <span>
                {e.delta > 0 ? "+" : ""}
                {money(e.delta)}
              </span>
              <small className="text-ink/50">{date(e.createdAt)}</small>
            </div>
          ))}
        </details>
        <details>
          <summary className="cursor-pointer py-2 font-medium">
            {t("身份与状态")}
          </summary>
          {player.identities?.map((i) => (
            <p className="my-2 text-sm" key={`${i.provider}:${i.subject}`}>
              {i.provider === "qq" ? "QQ" : i.provider} · {i.subject}
            </p>
          ))}
          {canWrite && (
            <div className="mt-4 grid gap-5">
              {!player.identities?.some((identity) => identity.provider === "qq") && <ActionForm
                done={done}
                label="绑定 QQ"
                submit={(f) =>
                  request(`${base}/identities`, "POST", {
                    provider: "qq",
                    subject: f.get("qq"),
                  })
                }
              >
                <Field label="QQ">
                  <input
                    className={input}
                    name="qq"
                    required
                    inputMode="numeric"
                    pattern="[1-9][0-9]{4,19}"
                  />
                </Field>
              </ActionForm>}
              <ActionForm
                done={done}
                label="更新状态"
                submit={(f) =>
                  request(`${base}/status`, "PATCH", {
                    status: f.get("status"),
                  })
                }
              >
                <Field label="状态">
                  <select
                    className={input}
                    name="status"
                    defaultValue={player.status}
                  >
                    <option value="active">{t("正常")}</option>
                    <option value="disabled">{t("停用")}</option>
                    <option value="banned">{t("封禁")}</option>
                  </select>
                </Field>
              </ActionForm>
            </div>
          )}
        </details>
      </div>
    </Modal>
  );
}
