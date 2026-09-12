import { PricingRing } from "./PricingRing";
import { useState } from "react";
import { Plus } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  ActionForm,
  Field,
  Modal,
  State,
  Table,
  button,
  cell,
  input,
  money,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
} from "./shared";

type Unit = {
  unitMinutes: number;
  unitPrice: number;
  roundGraceMinutes: number;
  priceCap: number;
};
type Rule = {
  id: string;
  label: string;
  priority: number;
  status?: string;
  weekdays?: number[];
  specificDates?: string[];
  timeRange?: { start: string; end: string };
  dateTimeRange?: { start: string; end: string };
  displayDateTimeRange?: { start: string; end: string };
  pricing?: Unit;
  priceCap?: number;
};
export type Pricing = {
  id: string;
  kind: "time.priority" | "time.cap" | "charge.fixed";
  name: string;
  enabled: boolean;
  status: string;
  provider: {
    id: string;
    label?: string;
    amount?: number;
    timeZone?: string;
    rules?: Rule[];
    includedPricingConfigIds?: string[];
  };
};
const kinds = {
  "time.priority": "按时计费",
  "charge.fixed": "固定收费",
  "time.cap": "消费封顶",
};
const newRule = (): Rule => ({
  id: crypto.randomUUID(),
  label: "",
  priority: 0,
  timeRange: { start: "00:00", end: "00:00" },
  pricing: {
    unitMinutes: 60,
    unitPrice: 10,
    roundGraceMinutes: 0,
    priceCap: 0,
  },
  priceCap: 0,
});
export function PricingPage() {
  const { t } = useI18n();
  const { canWrite } = useMerchant();
  const resource = useResource<{ pricingConfigs: Pricing[] }>(
    "pricing-configs",
  );
  const request = useStaffApi();
  const [edit, setEdit] = useState<Pricing | null>(null);
  const [archive, setArchive] = useState<Pricing | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const rows = resource.data?.pricingConfigs.filter(
    (row) => showArchived || row.status !== "archived",
  );
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("计费规则")}</h2>
        {canWrite && (
          <button
            className={primary}
            onClick={() =>
              setEdit({
                id: "",
                kind: "time.priority",
                name: "",
                enabled: true,
                status: "active",
                provider: { id: crypto.randomUUID(), rules: [newRule()] },
              })
            }
          >
            <Plus size={16} />
            {t("添加规则")}
          </button>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        {t("显示已归档")}
      </label>
      {!rows ? (
        <State error={resource.error} />
      ) : !rows.length ? (
        <State empty />
      ) : (
        <Table headers={["名称", "计费方式", "状态", "操作"]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className={`${cell} font-medium`}>{row.name}</td>
              <td className={cell}>
                {t(kinds[row.kind])}
                {row.kind === "charge.fixed" && (
                  <span className="ml-2">{money(row.provider.amount)}</span>
                )}
              </td>
              <td className={cell}>
                {t(
                  row.status === "archived"
                    ? "已归档"
                    : row.enabled
                      ? "启用"
                      : "停用",
                )}
              </td>
              <td className={cell}>
                {canWrite && (
                  <div className="flex gap-2">
                    <button
                      className={button}
                      onClick={() => setEdit(structuredClone(row))}
                    >
                      {t("编辑")}
                    </button>
                    <button className={button} onClick={() => setArchive(row)}>
                      {t(row.status === "archived" ? "恢复" : "归档")}
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {edit && (
        <Modal
          title={edit.id ? "编辑规则" : "添加规则"}
          close={() => setEdit(null)}
        >
          <PricingEditor
            value={edit}
            all={resource.data?.pricingConfigs ?? []}
            done={() => {
              setEdit(null);
              resource.reload();
            }}
          />
        </Modal>
      )}
      {archive && (
        <Modal
          title={archive.status === "archived" ? "恢复规则" : "归档规则"}
          close={() => setArchive(null)}
        >
          <ActionForm
            label="确认"
            done={() => {
              setArchive(null);
              resource.reload();
            }}
            submit={() =>
              request(
                `pricing-configs/${segment(archive.id)}/${archive.status === "archived" ? "restore" : "archive"}`,
                "POST",
                {},
              )
            }
          >
            <p>{archive.name}</p>
          </ActionForm>
        </Modal>
      )}
    </div>
  );
}
function PricingEditor({
  value,
  all,
  done,
}: {
  value: Pricing;
  all: Pricing[];
  done: () => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [draft, setDraft] = useState(value);
  const update = (patch: Partial<Pricing>) => setDraft({ ...draft, ...patch });
  const provider = (patch: Partial<Pricing["provider"]>) =>
    update({ provider: { ...draft.provider, ...patch } });
  const changeRule = (index: number, patch: Partial<Rule>) =>
    provider({
      rules: draft.provider.rules?.map((r, i) =>
        i === index ? { ...r, ...patch } : r,
      ),
    });
  return (
    <ActionForm
      done={done}
      submit={() =>
        request(
          `pricing-configs${draft.id ? `/${segment(draft.id)}` : ""}`,
          draft.id ? "PATCH" : "POST",
          {
            kind: draft.kind,
            name: draft.name,
            enabled: draft.enabled,
            provider: draft.provider,
          },
        )
      }
    >
      <Field label="名称">
        <input
          className={input}
          required
          maxLength={80}
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
        />
      </Field>
      <Field label="计费方式">
        <select
          className={input}
          value={draft.kind}
          disabled={!!draft.id}
          onChange={(e) => {
            const kind = e.target.value as Pricing["kind"];
            update({
              kind,
              provider:
                kind === "charge.fixed"
                  ? { id: draft.provider.id, label: draft.name, amount: 10 }
                  : {
                      id: draft.provider.id,
                      rules: [newRule()],
                      ...(kind === "time.cap"
                        ? { includedPricingConfigIds: [] }
                        : {}),
                    },
            });
          }}
        >
          {Object.entries(kinds).map(([key, label]) => (
            <option key={key} value={key}>
              {t(label)}
            </option>
          ))}
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={draft.status === "archived"}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        {t("启用")}
      </label>
      {draft.kind === "charge.fixed" ? (
        <>
          <Field label="账单名称">
            <input
              className={input}
              required
              value={draft.provider.label ?? ""}
              onChange={(e) => provider({ label: e.target.value })}
            />
          </Field>
          <Field label="金额">
            <input
              className={input}
              type="number"
              required
              min="0"
              step="0.01"
              value={draft.provider.amount ?? 0}
              onChange={(e) => provider({ amount: Number(e.target.value) })}
            />
          </Field>
        </>
      ) : (
        <>
          {draft.kind === "time.cap" && (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">
                {t("计入封顶的规则")}
              </legend>
              {all
                .filter(
                  (p) =>
                    p.id !== draft.id &&
                    p.kind !== "time.cap" &&
                    p.status !== "archived",
                )
                .map((p) => (
                  <label className="flex gap-2 text-sm" key={p.id}>
                    <input
                      type="checkbox"
                      checked={
                        draft.provider.includedPricingConfigIds?.includes(
                          p.id,
                        ) ?? false
                      }
                      onChange={(e) =>
                        provider({
                          includedPricingConfigIds: e.target.checked
                            ? [
                                ...(draft.provider.includedPricingConfigIds ??
                                  []),
                                p.id,
                              ]
                            : draft.provider.includedPricingConfigIds?.filter(
                                (id) => id !== p.id,
                              ),
                        })
                      }
                    />
                    {p.name}
                  </label>
                ))}
            </fieldset>
          )}
          <PricingRing
            value={draft}
            onSelect={(id) =>
              document
                .getElementById(`pricing-rule-${id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          />
          <div className="divide-y divide-ink/10">
            {draft.provider.rules?.map((rule, index) => (
              <div
                key={rule.id}
                id={`pricing-rule-${rule.id}`}
                className="grid scroll-mt-20 gap-3 py-5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {t("时段")} {index + 1}
                  </span>
                  <button
                    type="button"
                    className="focus-ring rounded p-2 text-sm text-coral"
                    disabled={draft.provider.rules!.length === 1}
                    onClick={() =>
                      provider({
                        rules: draft.provider.rules?.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    {t("移除")}
                  </button>
                </div>
                <Field label="名称">
                  <input
                    className={input}
                    required
                    value={rule.label}
                    onChange={(e) =>
                      changeRule(index, { label: e.target.value })
                    }
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="开始">
                    <input
                      className={input}
                      type="time"
                      required
                      value={rule.timeRange?.start ?? "00:00"}
                      onChange={(e) =>
                        changeRule(index, {
                          timeRange: {
                            start: e.target.value,
                            end: rule.timeRange?.end ?? "00:00",
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="结束">
                    <input
                      className={input}
                      type="time"
                      required
                      value={rule.timeRange?.end ?? "00:00"}
                      onChange={(e) =>
                        changeRule(index, {
                          timeRange: {
                            start: rule.timeRange?.start ?? "00:00",
                            end: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                </div>
                <p className="text-xs text-ink/50">
                  {t("开始与结束相同表示全天。")}
                </p>
                {draft.kind === "time.cap" ? (
                  <Field label="封顶金额">
                    <input
                      className={input}
                      required
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={rule.priceCap ?? 0}
                      onChange={(e) =>
                        changeRule(index, { priceCap: Number(e.target.value) })
                      }
                    />
                  </Field>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {(
                      [
                        ["unitMinutes", "每隔（分钟）", 1],
                        ["unitPrice", "收费金额", 0],
                        ["roundGraceMinutes", "宽限（分钟）", 0],
                        ["priceCap", "时段封顶（0 为不限）", 0],
                      ] as const
                    ).map(([key, label, min]) => (
                      <Field key={key} label={label}>
                        <input
                          className={input}
                          type="number"
                          required
                          min={min}
                          step={
                            key === "unitPrice" || key === "priceCap"
                              ? "0.01"
                              : "1"
                          }
                          value={rule.pricing?.[key] ?? 0}
                          onChange={(e) =>
                            changeRule(index, {
                              pricing: {
                                ...rule.pricing!,
                                [key]: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </Field>
                    ))}
                  </div>
                )}
                <details>
                  <summary className="cursor-pointer py-2 text-sm text-ink/60">
                    {t("日期与优先级")}
                  </summary>
                  <div className="mt-3 grid gap-3">
                    <Field label="优先级">
                      <input
                        className={input}
                        type="number"
                        step="1"
                        required
                        value={rule.priority}
                        onChange={(e) =>
                          changeRule(index, {
                            priority: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      {[1, 2, 3, 4, 5, 6, 0].map((day, i) => (
                        <label className="flex gap-1 text-sm" key={day}>
                          <input
                            type="checkbox"
                            checked={rule.weekdays?.includes(day) ?? true}
                            onChange={(e) =>
                              changeRule(index, {
                                weekdays: e.target.checked
                                  ? [...(rule.weekdays ?? []), day]
                                  : (
                                      rule.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
                                    ).filter((d) => d !== day),
                              })
                            }
                          />
                          {t(["一", "二", "三", "四", "五", "六", "日"][i]!)}
                        </label>
                      ))}
                    </div>
                    <Field label="指定日期（逗号分隔）">
                      <input
                        className={input}
                        placeholder="2026-10-01, 2026-10-02"
                        value={rule.specificDates?.join(", ") ?? ""}
                        onChange={(e) =>
                          changeRule(index, {
                            specificDates: e.target.value
                              ? e.target.value.split(",").map((s) => s.trim())
                              : undefined,
                          })
                        }
                      />
                    </Field>
                    {rule.dateTimeRange && (
                      <>
                        <Field label="生效时间">
                          <input
                            className={input}
                            value={rule.dateTimeRange.start}
                            onChange={(e) =>
                              changeRule(index, {
                                dateTimeRange: {
                                  ...rule.dateTimeRange!,
                                  start: e.target.value,
                                },
                              })
                            }
                          />
                        </Field>
                        <Field label="结束时间">
                          <input
                            className={input}
                            value={rule.dateTimeRange.end}
                            onChange={(e) =>
                              changeRule(index, {
                                dateTimeRange: {
                                  ...rule.dateTimeRange!,
                                  end: e.target.value,
                                },
                              })
                            }
                          />
                        </Field>
                      </>
                    )}
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={rule.status !== "archived"}
                        onChange={(e) =>
                          changeRule(index, {
                            status: e.target.checked ? "active" : "archived",
                          })
                        }
                      />
                      {t("启用时段")}
                    </label>
                  </div>
                </details>
              </div>
            ))}
          </div>
          <button
            type="button"
            className={button}
            onClick={() =>
              provider({ rules: [...(draft.provider.rules ?? []), newRule()] })
            }
          >
            <Plus size={16} />
            {t("添加时段")}
          </button>
        </>
      )}
    </ActionForm>
  );
}
