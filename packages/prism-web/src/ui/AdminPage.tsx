import { useI18n } from "../i18n";
import { useEffect, useState, type FormEvent } from "react";
import { Ban, ShieldCheck, UserCog, X } from "lucide-react";
import { Api, type Ban as BanRecord, type User, type UserSummary } from "../api";
import { RequireLogin } from "./RequireLogin";

const roleLabels: Record<User["role"], string> = {
  user: "玩家",
  admin: "管理员",
};

const banLabels: Record<BanRecord["subjectType"], string> = {
  user: "账号",
  ip: "网络地址",
  card: "卡片",
  machine: "设备",
};

export function AdminPage() {
  const { t, errorText } = useI18n();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [bans, setBans] = useState<BanRecord[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadUsers = async (search = query) => {
    const result = await Api.adminUsers(search);
    setUsers(result.users);
  };

  const loadBans = async () => {
    const result = await Api.bans();
    setBans(result.bans);
  };

  useEffect(() => {
    void Promise.all([loadUsers(""), loadBans()]).catch((caught) => setError(caught instanceof Error ? caught.message : "无法加载管理信息"));
  }, []);

  return (
    <RequireLogin roles={["admin"]}>
      <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="grid content-start gap-4">
          <h1 className="text-2xl font-semibold">{t("账号权限")}</h1>
          {error && <p className="rounded border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">{errorText(error)}</p>}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadUsers();
            }}
          >
            <input className="focus-ring min-h-11 flex-1 rounded border border-ink/10 bg-surface px-3" placeholder={t("搜索 MuNET 用户")} value={query} onChange={(event) => setQuery(event.target.value)} />
            <button className="focus-ring rounded bg-ink px-4 font-medium text-canvas">{t("搜索")}</button>
          </form>
          <div className="grid gap-3">
            {users.map((user) => (
              <UserRow key={user.id} user={user} onChanged={() => loadUsers()} />
            ))}
          </div>
        </div>
        <div className="grid content-start gap-4">
          <BanForm onCreated={loadBans} />
          <div className="rounded border border-ink/10 bg-panel p-4">
            <h2 className="flex items-center gap-2 font-semibold">
              <Ban size={18} />
              {t("暂停名单")}</h2>
            <div className="mt-3 grid gap-2">
              {bans.length === 0 ? (
                <p className="rounded border border-dashed border-ink/20 bg-surface p-4 text-sm text-ink/60">{t("暂无记录。")}</p>
              ) : (
                bans.map((ban) => (
                  <div key={ban.id} className="rounded border border-ink/10 bg-surface p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{t(banLabels[ban.subjectType])} · {ban.subjectValue}</p>
                        <p className="mt-1 text-sm text-ink/60">{ban.reason}</p>
                      </div>
                      <button className="focus-ring grid size-8 shrink-0 place-items-center rounded text-coral hover:bg-coral/10" title={t("移除")} onClick={async () => {
                        await Api.deleteBan(ban.id);
                        await loadBans();
                      }}>
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    </RequireLogin>
  );
}

function UserRow({ user, onChanged }: { user: UserSummary; onChanged: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [role, setRole] = useState<User["role"]>(user.role);
  const [busy, setBusy] = useState(false);

  return (
    <article className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink/10 bg-surface p-4">
      <div className="min-w-0">
        <p className="font-semibold">{user.displayName}</p>
        <p className="mt-1 text-sm text-ink/60">@{user.username} · {t("当前身份：")}{t(roleLabels[user.role])}</p>
      </div>
      <div className="flex items-center gap-2">
        <select className="focus-ring min-h-10 rounded border border-ink/10 bg-panel px-3" value={role} onChange={(event) => setRole(event.target.value as User["role"])}>
          {Object.entries(roleLabels).map(([value, label]) => (
            <option key={value} value={value}>{t(label)}</option>
          ))}
        </select>
        <button
          className="focus-ring flex min-h-10 items-center gap-2 rounded bg-mint px-3 font-medium text-white disabled:opacity-60"
          disabled={busy || role === user.role}
          onClick={async () => {
            setBusy(true);
            try {
              await Api.setUserRole(user.id, role);
              await onChanged();
            } finally {
              setBusy(false);
            }
          }}
        >
          <UserCog size={17} />
          {t("保存")}</button>
      </div>
    </article>
  );
}

function BanForm({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [subjectType, setSubjectType] = useState<BanRecord["subjectType"]>("user");
  const [subjectValue, setSubjectValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await Api.createBan({ subjectType, subjectValue, reason });
      setSubjectValue("");
      setReason("");
      await onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded border border-ink/10 bg-panel p-4 shadow-soft">
      <h2 className="flex items-center gap-2 font-semibold">
        <ShieldCheck size={18} />
        {t("暂停使用")}</h2>
      <div className="mt-3 grid gap-3">
        <select className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" value={subjectType} onChange={(event) => setSubjectType(event.target.value as BanRecord["subjectType"])}>
          {Object.entries(banLabels).map(([value, label]) => (
            <option key={value} value={value}>{t(label)}</option>
          ))}
        </select>
        <input className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" placeholder={t("对象标识")} value={subjectValue} onChange={(event) => setSubjectValue(event.target.value)} required />
        <input className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" placeholder={t("原因")} value={reason} onChange={(event) => setReason(event.target.value)} required />
        <button className="focus-ring min-h-11 rounded bg-ink px-4 font-medium text-canvas disabled:opacity-60" disabled={busy}>
          {t("添加")}</button>
      </div>
    </form>
  );
}
