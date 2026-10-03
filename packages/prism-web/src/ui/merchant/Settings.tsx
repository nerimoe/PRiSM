import { IdentityConverter } from "./IdentityConverter";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Store, Receipt, Users, MapPin, Plug, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n";
import { BillingSettings } from "../BillingPages";
import {
  ActionForm,
  Field,
  Modal,
  State,
  Table,
  button,
  cell,
  input,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
} from "./shared";

type Settings = {
  store: { name: string; timeZone: string };
  operations: { coinCooldownMs: number };
  registration: { defaultPresentId: string | null };
  homeAssistantConnection: { url: string; token: string };
  homeAssistantDevices: { id: string; name: string; alias?: string[] }[];
  ttLockConnection?: {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    appAccount: string;
    appPwd: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt?: number | null;
  };
  ttLockDevices?: {
    id: string;
    name: string;
    aliases: string[];
    lockId: number;
  }[];
  hinataIoDevices: {
    id: string;
    name: string;
    url: string;
    password: string;
    salt: string;
    coinKey: number;
    cardType: string;
    aliases: string[];
  }[];
};
type Token = { id: string; label: string; role: string; status: string };
const groups = [
  {
    id: "general",
    label: "基本资料",
    description: "店铺名称、封面、位置与时区。",
    icon: Store,
  },
  {
    id: "billing",
    label: "营业与计费",
    description: "入场计费、前台收银与收费规则。",
    icon: Receipt,
  },
  {
    id: "players",
    label: "玩家与身份",
    description: "身份绑定要求、新玩家注册与身份转换。",
    icon: Users,
  },
  {
    id: "devices",
    label: "位置与设备",
    description: "到店位置校验、投币冷却与门锁连接。",
    icon: MapPin,
  },
  {
    id: "integrations",
    label: "Bot 与接入",
    description: "Bot 配置与机台接入凭据。",
    icon: Plug,
  },
  {
    id: "members",
    label: "成员与权限",
    description: "管理店铺成员及其操作权限。",
    icon: ShieldCheck,
  },
] as const;

export function SettingsPage({
  shopDetails,
  members,
}: {
  shopDetails: ReactNode;
  members: ReactNode;
}) {
  const { t } = useI18n();
  const { shopCode, owner } = useMerchant();
  const request = useStaffApi();
  const [params] = useSearchParams();
  const group =
    groups.find((item) => item.id === params.get("group")) ?? groups[0];
  const settings = useResource<{ settings: Settings }>(
    owner ? "settings" : null,
  );
  const gifts = useResource<{
    presents: { id: string; name: string; status: string }[];
  }>(owner ? "presents" : null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    window.addEventListener("prism-shop-settings", settings.reload);
    return () =>
      window.removeEventListener("prism-shop-settings", settings.reload);
  }, [settings.reload]);
  // Staff settings are a whole-document API; merge only this form's fields into the latest document.
  async function saveSettings(patch: Partial<Settings>) {
    const current = await request<{ settings: Settings }>("settings");
    await request("settings", "PUT", { ...current.settings, ...patch });
  }
  function saved(id: string) {
    setNotice(id);
    settings.reload();
  }
  if (!owner) return null;
  return (
    <div className="grid gap-5">
      <h2 className="text-xl font-semibold">{t("店铺设置")}</h2>
      <div className="grid gap-5 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <nav
          aria-label={t("设置分类")}
          className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:self-start"
        >
          {groups.map((item) => {
            const next = new URLSearchParams(params);
            next.set("group", item.id);
            return (
              <Link
                key={item.id}
                to={`?${next}`}
                aria-current={group.id === item.id ? "page" : undefined}
                className={`focus-ring flex shrink-0 items-center gap-2 rounded-lg px-3 py-3 text-sm ${group.id === item.id ? "bg-mint/10 font-semibold text-ink" : "text-ink/60 hover:bg-ink/5 hover:text-ink"}`}
              >
                <item.icon size={18} aria-hidden="true" />
                {t(item.label)}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 space-y-5">
          <header>
            <h3 className="text-lg font-semibold">{t(group.label)}</h3>
            <p className="mt-1 text-sm leading-relaxed text-ink/60">
              {t(group.description)}
            </p>
          </header>
          {notice === group.id && (
            <p role="status" className="text-sm text-mint">
              {t("已保存")}
            </p>
          )}
          {/* Keep drafts and one-time credentials mounted when changing groups. */}
          <div hidden={group.id !== "general"}>{shopDetails}</div>
          <BillingSettings
            shopCode={shopCode}
            embedded
            section={
              group.id === "billing" ||
              group.id === "players" ||
              group.id === "devices"
                ? group.id
                : null
            }
          />
          <div hidden={group.id !== "players"}>
            <div className="grid gap-5">
              {!settings.data ? (
                <State error={settings.error} />
              ) : (
                <section className="rounded-xl border border-ink/10 bg-panel p-5">
                  <h4 className="mb-4 font-semibold">{t("新玩家礼物")}</h4>
                  {!gifts.data ? (
                    <State error={gifts.error} />
                  ) : (
                    <ActionForm
                      label="保存玩家礼物"
                      done={() => saved("players")}
                      submit={(f) =>
                        saveSettings({
                          registration: {
                            defaultPresentId:
                              String(f.get("present") || "") || null,
                          },
                        })
                      }
                    >
                      <Field label="新玩家礼物">
                        <select
                          className={input}
                          name="present"
                          defaultValue={
                            settings.data.settings.registration
                              .defaultPresentId ?? ""
                          }
                          disabled={!gifts.data}
                        >
                          <option value="">{t("无")}</option>
                          {gifts.data?.presents
                            .filter((p) => p.status !== "archived")
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                    </ActionForm>
                  )}
                </section>
              )}
              <details className="rounded-xl border border-ink/10 bg-panel p-5">
                <summary className="cursor-pointer font-semibold">
                  {t("平台身份转换")}
                </summary>
                <p className="mt-2 text-sm leading-relaxed text-ink/60">
                  {t("需要变更平台标识时使用，由店主预览后主动执行。")}
                </p>
                <div className="mt-5">
                  <IdentityConverter
                    key={shopCode}
                    shopCode={shopCode}
                    embedded
                  />
                </div>
              </details>
            </div>
          </div>
          <div hidden={group.id !== "devices"}>
            <div className="grid gap-5">
              {!settings.data ? (
                <State error={settings.error} />
              ) : (
                <>
                  <section className="rounded-xl border border-ink/10 bg-panel p-5">
                    <h4 className="mb-4 font-semibold">{t("投币设置")}</h4>
                    <ActionForm
                      label="保存投币设置"
                      done={() => saved("devices")}
                      submit={(f) =>
                        saveSettings({
                          operations: {
                            coinCooldownMs: Number(f.get("cooldown")) * 1000,
                          },
                        })
                      }
                    >
                      <Field label="投币冷却时间（秒）">
                        <input
                          className={input}
                          type="number"
                          min="0"
                          step="0.1"
                          name="cooldown"
                          defaultValue={
                            settings.data.settings.operations.coinCooldownMs /
                            1000
                          }
                          required
                        />
                      </Field>
                    </ActionForm>
                  </section>
                  <TTLockConnection
                    settings={settings.data.settings}
                    reload={settings.reload}
                  />
                </>
              )}
            </div>
          </div>
          <div hidden={group.id !== "integrations"}>
            <Tokens shopCode={shopCode} />
          </div>
          <div hidden={group.id !== "members"}>{members}</div>
        </div>
      </div>
    </div>
  );
}
function Tokens({ shopCode }: { shopCode: string }) {
  const { t } = useI18n();
  const request = useStaffApi();
  const tokens = useResource<{ apiTokens: Token[] }>("api-tokens");
  const [create, setCreate] = useState(false);
  const [secret, setSecret] = useState("");
  const [revoke, setRevoke] = useState<Token | null>(null);
  return (
    <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{t("接入凭据")}</h3>
        <button className={button} onClick={() => setCreate(true)}>
          {t("创建凭据")}
        </button>
      </div>
      <div className="grid gap-3 rounded-lg border border-ink/10 bg-surface p-4">
        <div>
          <p className="text-sm font-medium">{t("Koishi / 集成配置")}</p>
          <p className="mt-1 text-xs text-ink/60">
            {t("将下面的店铺编号和正式 API 地址填入 Bot 配置。")}
          </p>
        </div>
        <CopyValue label="店铺编号" value={shopCode} />
        <CopyValue label="API 地址" value={window.location.origin} />
      </div>
      {secret && (
        <div role="status" className="rounded border border-ink/15 p-4">
          <p className="mb-2 text-sm">{t("请保存凭据，关闭后不再显示。")}</p>
          <code className="block select-all break-all text-sm">{secret}</code>
          <button className={`${button} mt-3`} onClick={() => setSecret("")}>
            {t("已保存，关闭")}
          </button>
        </div>
      )}
      {tokens.data ? (
        <Table headers={["名称", "用途", "状态", "操作"]}>
          {tokens.data.apiTokens.map((token) => (
            <tr key={token.id}>
              <td className={cell}>{token.label}</td>
              <td className={cell}>
                {token.role === "integration" ? "Bot" : t("机台")}
              </td>
              <td className={cell}>
                {t(token.status === "active" ? "有效" : "已撤销")}
              </td>
              <td className={cell}>
                {token.status === "active" && (
                  <button className={button} onClick={() => setRevoke(token)}>
                    {t("撤销")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <State error={tokens.error} />
      )}
      {create && (
        <Modal title="创建凭据" close={() => setCreate(false)}>
          <ActionForm
            done={() => {
              setCreate(false);
              tokens.reload();
            }}
            submit={async (f) => {
              const result = await request<{
                apiToken: Token & { token: string };
              }>("api-tokens", "POST", {
                label: f.get("name"),
                role: f.get("role"),
              });
              setSecret(result.apiToken.token);
            }}
          >
            <Field label="名称">
              <input className={input} name="name" required />
            </Field>
            <Field label="用途">
              <select className={input} name="role">
                <option value="integration">Bot</option>
                <option value="machine">{t("机台")}</option>
              </select>
            </Field>
          </ActionForm>
        </Modal>
      )}
      {revoke && (
        <Modal title="撤销凭据" close={() => setRevoke(null)}>
          <ActionForm
            label="确认撤销"
            done={() => {
              setRevoke(null);
              tokens.reload();
            }}
            submit={() =>
              request(`api-tokens/${segment(revoke.id)}/revoke`, "POST", {})
            }
          >
            <p>{revoke.label}</p>
          </ActionForm>
        </Modal>
      )}
    </section>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
  };
  return (
    <div className="grid gap-1">
      <span className="text-xs text-ink/60">{t(label)}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border border-ink/10 bg-panel px-3 py-2 text-sm">
          {value}
        </code>
        <button className={button} type="button" onClick={copy}>
          {t("复制")}
        </button>
      </div>
    </div>
  );
}
function TTLockConnection({
  settings,
  reload,
}: {
  settings: Settings;
  reload: () => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [saved, setSaved] = useState(false);
  const connection = settings.ttLockConnection;
  return (
    <details className="rounded-xl border border-ink/10 bg-panel p-5">
      <summary className="cursor-pointer font-semibold">
        {t("连接 TTLock 账号")}
      </summary>
      <div className="mt-5">
        <ActionForm
          done={() => {
            setSaved(true);
            reload();
          }}
          submit={async (f) => {
            const current = await request<{ settings: Settings }>("settings");
            return request("settings", "PUT", {
              ...current.settings,
              ttLockConnection: {
                ...current.settings.ttLockConnection,
                baseUrl: f.get("baseUrl"),
                clientId: f.get("clientId"),
                clientSecret: f.get("clientSecret"),
                appAccount: f.get("appAccount"),
                appPwd: f.get("appPwd"),
                accessToken: f.get("accessToken"),
                refreshToken: f.get("refreshToken"),
                accessTokenExpiresAt:
                  current.settings.ttLockConnection?.accessTokenExpiresAt ??
                  null,
              },
            });
          }}
        >
          {(
            [
              ["baseUrl", "服务地址"],
              ["clientId", "Client ID"],
              ["clientSecret", "Client Secret"],
              ["appAccount", "TTLock 账号"],
              ["appPwd", "账号密码（MD5）"],
              ["accessToken", "Access Token"],
              ["refreshToken", "Refresh Token"],
            ] as const
          ).map(([key, label]) => (
            <Field label={label} key={key}>
              <input
                className={input}
                name={key}
                type={
                  [
                    "clientSecret",
                    "appPwd",
                    "accessToken",
                    "refreshToken",
                  ].includes(key)
                    ? "password"
                    : key === "baseUrl"
                      ? "url"
                      : "text"
                }
                autoComplete="off"
                defaultValue={
                  connection?.[key] ??
                  (key === "baseUrl" ? "https://api.ttlock.com" : "")
                }
              />
            </Field>
          ))}
          {saved && (
            <p role="status" className="text-sm text-mint">
              {t("已保存")}
            </p>
          )}
        </ActionForm>
      </div>
    </details>
  );
}
