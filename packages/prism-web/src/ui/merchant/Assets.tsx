import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { useI18n } from "../../i18n";
import { displayDateTime } from "../bill-time";
import { useScrollFade } from "../use-scroll-fade";
import {
  AssetDetails,
  EffectDetails,
  PresentDetails,
  RedeemCodeDetails,
  assetTypeName,
  availabilityLabel,
  effectSummary,
} from "./AssetDetails";
import type { Effect, Grant, Present, RedeemCode } from "./asset-types";
import { RedeemCodeCreateModal, RedeemCodesTab } from "./RedeemCodesTab";
import {
  ActionForm,
  Field,
  Modal,
  State,
  Table,
  button,
  cell,
  input,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
  type Asset,
} from "./shared";

const tableBtn = `${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-sm`;

function StatusPill({
  item,
}: {
  item: { activeAt?: string | null; expiresAt?: string | null; status?: string };
}) {
  const { t } = useI18n();
  const label = availabilityLabel(item, t);
  const archived = item.status === "archived";
  const expired =
    !archived && Boolean(item.expiresAt && Date.parse(item.expiresAt) <= Date.now());
  const pending =
    !archived && !expired && Boolean(item.activeAt && Date.parse(item.activeAt) > Date.now());
  const tone = archived
    ? "bg-ink/5 text-ink/50"
    : expired
      ? "bg-coral/10 text-coral"
      : pending
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400";
  const dot = archived
    ? "bg-ink/35"
    : expired
      ? "bg-coral"
      : pending
        ? "bg-amber-500"
        : "bg-[#23815d] dark:bg-emerald-400";
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function AssetsPage() {
  const { t } = useI18n();
  const { canWrite, timeZone } = useMerchant();
  const request = useStaffApi();
  const assets = useResource<{ assetDefinitions: Asset[] }>(
    "asset-definitions",
  );
  const effects = useResource<{ pricingEffects: Effect[] }>("pricing-effects");
  const presents = useResource<{ presents: Present[] }>("presents");
  const [codesRevision, setCodesRevision] = useState(0);
  // The tab is in the URL so other pages can link straight to gifts or codes.
  const [params, setParams] = useSearchParams();
  const tabs = ["assets", "effects", "gifts", "codes"];
  const tab = tabs.includes(params.get("tab") ?? "") ? params.get("tab")! : "assets";
  const setTab = (next: string) => {
    const query = new URLSearchParams(params);
    if (next === "assets") query.delete("tab");
    else query.set("tab", next);
    setParams(query, { replace: true });
  };
  const tabRef = useScrollFade<HTMLElement>();
  const [creatingAsset, setCreatingAsset] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [effect, setEffect] = useState<Effect | null>(null);
  const [gift, setGift] = useState(false);
  const [code, setCode] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [detail, setDetail] = useState<
    | { kind: "asset"; item: Asset }
    | { kind: "effect"; item: Effect }
    | { kind: "present"; item: Present }
    | { kind: "code"; item: RedeemCode }
    | null
  >(null);
  const date = (value: string | null | undefined) =>
    value ? displayDateTime(value, timeZone) : "—";
  const [confirmation, setConfirmation] = useState<{
    name: string;
    path: string;
  } | null>(null);
  const reload = () => {
    assets.reload();
    effects.reload();
    presents.reload();
    setCodesRevision((value) => value + 1);
  };
  const visibleAssets =
    assets.data?.assetDefinitions.filter(
      (a) => showArchived || a.status !== "archived",
    ) ?? [];
  const visibleEffects =
    effects.data?.pricingEffects.filter(
      (e) => showArchived || e.status !== "archived",
    ) ?? [];
  const visiblePresents =
    presents.data?.presents.filter(
      (p) => showArchived || p.status !== "archived",
    ) ?? [];
  const createLabel =
    tab === "assets"
      ? "新建资产"
      : tab === "effects"
        ? "新建优惠"
        : tab === "gifts"
          ? "新建礼物"
          : "新建兑换码";
  function startCreate() {
    if (tab === "assets") {
      setCreatingAsset(true);
      setEditing({
        type: "coupon",
        code: crypto.randomUUID(),
        name: "",
        stackable: true,
        pricingEffectId: null,
        status: "active",
        metadata: null,
      });
    } else if (tab === "effects")
      setEffect({
        id: "",
        name: "",
        type: "discount",
        scope: "unified",
        value: 1,
        consumable: true,
        limitPerDay: null,
        status: "active",
        config: null,
      });
    else if (tab === "gifts") setGift(true);
    else setCode(true);
  }
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("资产与兑换")}</h2>
        {canWrite && (
          <button
            className={primary}
            onClick={startCreate}
          >
            <Plus size={16} />
            {t(createLabel)}
          </button>
        )}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="scroll-fade min-w-0 flex-1">
          <nav
            ref={tabRef}
            className="flex gap-1 overflow-x-auto border-b border-ink/10"
            aria-label={t("资产分类")}
          >
            {[
              ["assets", "资产"],
              ["effects", "优惠"],
              ["gifts", "礼物"],
              ["codes", "兑换码"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={`focus-ring whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === key ? "border-mint font-semibold text-ink" : "border-transparent text-ink/55 hover:text-ink"}`}
                onClick={() => setTab(key!)}
                aria-current={tab === key ? "page" : undefined}
              >
                {t(label!)}
              </button>
            ))}
          </nav>
        </div>
        {tab !== "codes" && (
          <label className="flex shrink-0 items-center gap-2 pb-1 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {t("显示已归档")}
          </label>
        )}
      </div>
      {tab === "assets" &&
        (!assets.data ? (
          <State error={assets.error} />
        ) : !visibleAssets.length ? (
          <Empty
            title="还没有资产"
            hint="资产是玩家账户里能持有的东西，比如余额和优惠券。"
            action={canWrite ? { label: createLabel, run: startCreate } : undefined}
          />
        ) : (
          <Table
            headers={["名称", "类型", "关联优惠", "有效期", "状态", "操作"]}
          >
            {visibleAssets.map((a) => (
                <tr key={`${a.type}:${a.code}`}>
                  <td className={cell}>
                    <p className="font-medium">{a.name}</p>
                    <p className="mt-1 text-xs text-ink/60">
                      {t(a.stackable ? "数量可叠加" : "数量不可叠加")}
                    </p>
                    {a.metadata?.hiddenFromPlayer === true && (
                      <p className="mt-1 text-xs text-ink/60">
                        {t("对玩家隐藏")}
                      </p>
                    )}
                  </td>
                  <td className={cell}>{assetTypeName(a.type, t)}</td>
                  <td className={cell}>
                    {effects.data?.pricingEffects.find(
                      (e) => e.id === a.pricingEffectId,
                    )?.name ??
                      a.pricingEffect?.name ??
                      a.pricingEffectId ??
                      t("无")}
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    <p>{a.activeAt ? date(a.activeAt) : t("立即生效")}</p>
                    <p className="mt-1 text-xs text-ink/60">
                      {a.expiresAt ? date(a.expiresAt) : t("永久有效")}
                    </p>
                  </td>
                  <td className={cell}><StatusPill item={a} /></td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={tableBtn}
                        onClick={() => setDetail({ kind: "asset", item: a })}
                      >
                        {t("详情")}
                      </button>
                      {canWrite && (
                        <>
                          {a.status !== "archived" && (
                            <button
                              className={tableBtn}
                              onClick={() => {
                                setCreatingAsset(false);
                                setEditing(a);
                              }}
                            >
                              {t("编辑")}
                            </button>
                          )}
                          <button
                            className={tableBtn}
                            onClick={() =>
                              setConfirmation({
                                name: a.name,
                                path: `asset-definitions/${segment(a.type)}/${segment(a.code)}/${a.status === "archived" ? "restore" : "archive"}`,
                              })
                            }
                          >
                            {t(a.status === "archived" ? "恢复" : "归档")}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </Table>
        ))}
      {tab === "effects" &&
        (!effects.data ? (
          <State error={effects.error} />
        ) : !visibleEffects.length ? (
          <Empty
            title="还没有优惠"
            hint="优惠决定结账时怎么抵扣：免单、减固定金额或打折。把优惠关联到一种资产，玩家持有这种资产时结账自动抵扣。"
            action={canWrite ? { label: createLabel, run: startCreate } : undefined}
          />
        ) : (
          <Table headers={["名称", "优惠方式", "使用限制", "状态", "操作"]}>
            {visibleEffects.map((e) => (
                <tr key={e.id}>
                  <td className={`${cell} font-medium`}>{e.name}</td>
                  <td className={cell}>
                    <p>{effectSummary(e, t)}</p>
                    <p className="mt-1 text-xs text-ink/60">
                      {t(e.scope === "session" ? "单项消费" : "整笔账单")}
                    </p>
                  </td>
                  <td className={cell}>
                    <p>{t(e.consumable ? "使用后扣除" : "使用后保留")}</p>
                    <p className="mt-1 text-xs text-ink/60">
                      {e.limitPerDay == null
                        ? t("每日不限次数")
                        : t("每日最多 {count} 次", { count: e.limitPerDay })}
                    </p>
                  </td>
                  <td className={cell}><StatusPill item={e} /></td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={tableBtn}
                        onClick={() => setDetail({ kind: "effect", item: e })}
                      >
                        {t("详情")}
                      </button>
                      {canWrite && (
                        <>
                          {e.status !== "archived" && (
                            <button
                              className={tableBtn}
                              onClick={() => setEffect(e)}
                            >
                              {t("编辑")}
                            </button>
                          )}
                          <button
                            className={tableBtn}
                            onClick={() =>
                              setConfirmation({
                                name: e.name,
                                path: `pricing-effects/${segment(e.id)}/${e.status === "archived" ? "restore" : "archive"}`,
                              })
                            }
                          >
                            {t(e.status === "archived" ? "恢复" : "归档")}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </Table>
        ))}
      {tab === "gifts" &&
        (!presents.data ? (
          <State error={presents.error} />
        ) : !visiblePresents.length ? (
          <Empty
            title="还没有礼物"
            hint="礼物把几种资产打包发放，可以设为新玩家礼物，也可以通过兑换码让玩家自己领。"
            action={canWrite ? { label: createLabel, run: startCreate } : undefined}
          />
        ) : (
          <Table headers={["礼物", "内容", "领取限制", "状态", "操作"]}>
            {visiblePresents.map((p) => (
                <tr key={p.id}>
                  <td className={`${cell} font-medium`}>{p.name}</td>
                  <td className={cell}>
                    {p.grants.map((g, i) => (
                      <p key={i}>
                        {assets.data?.assetDefinitions.find(
                          (a) =>
                            a.type === g.assetType && a.code === g.assetCode,
                        )?.name ?? g.assetCode}{" "}
                        × {g.amount}
                        {g.maxPerPlayer !== undefined &&
                          ` (${t("每位玩家限领 {count} 次", { count: g.maxPerPlayer })})`}
                      </p>
                    ))}
                  </td>
                  <td className={cell}>
                    {t(p.oncePerPlayer ? "每位玩家仅限一次" : "可重复领取")}
                  </td>
                  <td className={cell}><StatusPill item={p} /></td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={tableBtn}
                        onClick={() => setDetail({ kind: "present", item: p })}
                      >
                        {t("详情")}
                      </button>
                      {canWrite && (
                        <button
                          className={tableBtn}
                          onClick={() =>
                            setConfirmation({
                              name: p.name,
                              path: `presents/${segment(p.id)}/${p.status === "archived" ? "restore" : "archive"}`,
                            })
                          }
                        >
                          {t(p.status === "archived" ? "恢复" : "归档")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </Table>
        ))}
      {tab === "codes" && (
        <RedeemCodesTab
          presents={presents.data?.presents ?? []}
          canWrite={canWrite}
          timeZone={timeZone}
          reloadKey={codesRevision}
          onCreate={() => setCode(true)}
          onOpenGifts={() => setTab("gifts")}
          onViewDetail={(c) => setDetail({ kind: "code", item: c })}
          onRevoke={(c) =>
            setConfirmation({
              name: c.code,
              path: `redeem-codes/${segment(c.id)}/revoke`,
            })
          }
        />
      )}
      {detail && (
        <Modal
          title={
            {
              asset: "资产详情",
              effect: "优惠详情",
              present: "礼物详情",
              code: "兑换码详情",
            }[detail.kind]
          }
          close={() => setDetail(null)}
        >
          {detail.kind === "asset" && (
            <AssetDetails
              asset={detail.item}
              effects={effects.data?.pricingEffects ?? []}
            />
          )}
          {detail.kind === "effect" && <EffectDetails effect={detail.item} />}
          {detail.kind === "present" && (
            <PresentDetails
              present={detail.item}
              assets={assets.data?.assetDefinitions ?? []}
            />
          )}
          {detail.kind === "code" && (
            <RedeemCodeDetails
              code={detail.item}
              presents={presents.data?.presents ?? []}
              assets={assets.data?.assetDefinitions ?? []}
            />
          )}
        </Modal>
      )}
      {editing && (
        <Modal
          title={creatingAsset ? "新建资产" : "编辑资产"}
          close={() => setEditing(null)}
          wide
        >
          <ActionForm
            done={() => {
              setEditing(null);
              reload();
            }}
            submit={(f) => {
              if (
                creatingAsset &&
                assets.data?.assetDefinitions.some(
                  (a) => a.type === editing.type && a.code === editing.code,
                )
              )
                throw new Error(t("资产编号已存在"));
              return request(
                `asset-definitions/${segment(editing.type)}/${segment(editing.code)}`,
                "PUT",
                {
                  ...editing,
                  name: f.get("name"),
                  stackable: f.get("stackable") === "on",
                  pricingEffectId: f.get("effect") || null,
                },
              );
            }}
          >
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold">{t("基本信息")}</h3>
              <Field label="名称">
                <input
                  className={input}
                  name="name"
                  required
                  defaultValue={editing.name}
                />
              </Field>
              {creatingAsset && (
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-sm font-medium">{t("类型")}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        ["currency", "余额", "玩家充值得到的钱，结账时扣除"],
                        ["coupon", "优惠券", "券或次数，可关联优惠在结账时抵扣"],
                      ] as const
                    ).map(([value, label, hint]) => (
                      <label
                        key={value}
                        className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${
                          editing.type === value
                            ? "border-mint/50 bg-mint/[0.04]"
                            : "border-ink/15"
                        }`}
                      >
                        <input
                          type="radio"
                          name="assetType"
                          className="mt-0.5"
                          checked={editing.type === value}
                          onChange={() =>
                            setEditing({
                              ...editing,
                              type: value,
                              code:
                                value === "currency"
                                  ? "paid"
                                  : crypto.randomUUID(),
                            })
                          }
                        />
                        <span className="min-w-0">
                          <strong className="block font-medium">{t(label)}</strong>
                          <span className="mt-0.5 block text-xs text-ink/55">
                            {t(hint)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </section>
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold">{t("计价与叠加")}</h3>
              <Field label="优惠">
                <select
                  className={input}
                  name="effect"
                  defaultValue={editing.pricingEffectId ?? ""}
                >
                  <option value="">{t("无")}</option>
                  {effects.data?.pricingEffects
                    .filter(
                      (e) =>
                        e.status !== "archived" ||
                        e.id === editing.pricingEffectId,
                    )
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                        {e.status === "archived" ? ` · ${t("已归档")}` : ""}
                      </option>
                    ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  name="stackable"
                  type="checkbox"
                  defaultChecked={editing.stackable}
                />
                {t("数量可叠加（同一玩家可以持有多份）")}
              </label>
            </section>
          </ActionForm>
        </Modal>
      )}
      {effect && (
        <Modal title="优惠" close={() => setEffect(null)}>
          <ActionForm
            done={() => {
              setEffect(null);
              reload();
            }}
            submit={(f) =>
              request(
                `pricing-effects/${segment(effect.id || crypto.randomUUID())}`,
                "PUT",
                {
                  ...effect,
                  name: f.get("name"),
                  type: f.get("type"),
                  scope: f.get("scope"),
                  value:
                    f.get("type") === "free" ? null : Number(f.get("value")),
                  consumable: f.get("consumable") === "on",
                  limitPerDay: f.get("limit") ? Number(f.get("limit")) : null,
                },
              )
            }
          >
            <Field label="名称">
              <input
                className={input}
                name="name"
                required
                defaultValue={effect.name}
              />
            </Field>
            <EffectValueFields key={effect.id} effect={effect} />
            <Field label="范围">
              <select
                className={input}
                name="scope"
                defaultValue={effect.scope}
              >
                <option value="unified">{t("整笔账单")}</option>
                <option value="session">{t("单项消费")}</option>
              </select>
            </Field>
            <Field label="每日使用上限">
              <input
                className={input}
                name="limit"
                type="number"
                min="1"
                step="1"
                defaultValue={effect.limitPerDay ?? ""}
              />
            </Field>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                name="consumable"
                defaultChecked={effect.consumable}
              />
              {t("使用后扣除")}
            </label>
          </ActionForm>
        </Modal>
      )}
      {gift && (
        <Modal title="添加礼物" close={() => setGift(false)}>
          <GiftForm
            assets={assets.data?.assetDefinitions ?? []}
            done={() => {
              setGift(false);
              reload();
            }}
          />
        </Modal>
      )}
      {code && (
        <RedeemCodeCreateModal
          presents={presents.data?.presents ?? []}
          timeZone={timeZone}
          onClose={() => setCode(false)}
          onDone={() => {
            setCode(false);
            reload();
          }}
        />
      )}
      {confirmation && (
        <Modal title="确认操作" close={() => setConfirmation(null)}>
          <ActionForm
            label="确认"
            done={() => {
              setConfirmation(null);
              reload();
            }}
            submit={() => request(confirmation.path, "POST", {})}
          >
            <p>{confirmation.name}</p>
          </ActionForm>
        </Modal>
      )}
    </div>
  );
}
function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: { label: string; run: () => void };
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-dashed border-ink/20 px-6 py-14 text-center">
      <p className="font-medium">{t(title)}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink/55">
        {t(hint)}
      </p>
      {action && (
        <button type="button" className={`${primary} mt-5`} onClick={action.run}>
          <Plus size={16} />
          {t(action.label)}
        </button>
      )}
    </div>
  );
}

const effectTypes = [
  ["free", "免费"],
  ["discount", "减免金额"],
  ["percentage-discount", "折扣比例"],
  ["surcharge", "加收金额"],
] as const;

function EffectValueFields({ effect }: { effect: Effect }) {
  const { t } = useI18n();
  const [type, setType] = useState(effect.type);
  return (
    <>
      <Field label="优惠方式">
        <select
          className={input}
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value as Effect["type"])}
        >
          {effectTypes.map(([key, label]) => (
            <option key={key} value={key}>
              {t(label)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="数值" unit={type === "percentage-discount" ? "%" : type === "free" ? undefined : "元"}>
        <input
          className={input}
          type="number"
          min="0"
          step="0.01"
          name="value"
          disabled={type === "free"}
          defaultValue={effect.value ?? 0}
        />
      </Field>
    </>
  );
}

function GiftForm({ assets, done }: { assets: Asset[]; done: () => void }) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [grants, setGrants] = useState<Grant[]>([
    {
      assetType: "",
      assetCode: "",
      amount: 1,
      mergeStrategy: "stack",
      activeAt: null,
      expiresAt: null,
    },
  ]);
  return (
    <ActionForm
      done={done}
      submit={(f) =>
        request("presents", "POST", {
          name: f.get("name"),
          oncePerPlayer: f.get("once") === "on",
          activeAt: null,
          expiresAt: null,
          grants,
        })
      }
    >
      <Field label="名称">
        <input className={input} name="name" required />
      </Field>
      <label className="flex gap-2 text-sm">
        <input type="checkbox" name="once" defaultChecked />
        {t("每位玩家仅限一次")}
      </label>
      {grants.map((g, index) => (
        <div
          className="grid grid-cols-[1fr_6rem_7rem_auto] items-end gap-2"
          key={index}
        >
          <Field label="资产">
            <select
              className={input}
              required
              value={`${g.assetType}|${g.assetCode}`}
              onChange={(e) => {
                const [assetType, assetCode] = e.target.value.split("|");
                setGrants(
                  grants.map((v, i) =>
                    i === index
                      ? { ...v, assetType: assetType!, assetCode: assetCode! }
                      : v,
                  ),
                );
              }}
            >
              <option value="|" disabled>
                {t("请选择")}
              </option>
              {assets
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
              min="0.01"
              step="0.01"
              value={g.amount}
              required
              onChange={(e) =>
                setGrants(
                  grants.map((v, i) =>
                    i === index ? { ...v, amount: Number(e.target.value) } : v,
                  ),
                )
              }
            />
          </Field>
          <Field label="每位玩家限领次数">
            <input
              className={input}
              type="number"
              min="1"
              step="1"
              placeholder={t("不限")}
              value={g.maxPerPlayer ?? ""}
              onChange={(e) =>
                setGrants(
                  grants.map((v, i) => {
                    if (i !== index) return v;
                    const { maxPerPlayer: _drop, ...rest } = v;
                    return e.target.value === ""
                      ? rest
                      : { ...rest, maxPerPlayer: Number(e.target.value) };
                  }),
                )
              }
            />
          </Field>
          <button
            type="button"
            className={button}
            disabled={grants.length === 1}
            onClick={() => setGrants(grants.filter((_, i) => i !== index))}
          >
            {t("移除")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className={button}
        onClick={() =>
          setGrants([
            ...grants,
            {
              assetType: "",
              assetCode: "",
              amount: 1,
              mergeStrategy: "stack",
              activeAt: null,
              expiresAt: null,
            },
          ])
        }
      >
        {t("添加资产")}
      </button>
    </ActionForm>
  );
}
