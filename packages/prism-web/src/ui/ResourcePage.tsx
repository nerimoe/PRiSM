import { useCallback, useState } from "react";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import type { Notice } from "../api";
import { useI18n } from "../i18n";
import { PlayerPageBlocks } from "./PlayerPageBlocks";
import { StatusView } from "./page-blocks/StatusView";
import { ShopHero } from "./SessionContent";
import { usePlayerPage } from "./use-player-page";

export function ResourcePage() {
  const { ticket: paramTicket = "", publicId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();
  const ticket = new URLSearchParams(hash.slice(1)).get("ticket") || searchParams.get("ticket") || paramTicket || publicId;
  const [expiredTicket, setExpiredTicket] = useState<string | null>(null);
  const [expiredNotice, setExpiredNotice] = useState<Notice | undefined>();
  const onExpired = useCallback((notice?: Notice) => {
    setExpiredTicket(ticket);
    setExpiredNotice(notice);
  }, [ticket]);
  const expired = expiredTicket === ticket ||
    window.location.pathname === "/m/expired" ||
    searchParams.get("expired") === "1";
  return expired || !ticket ? <ResourceExpiredPage notice={expiredNotice} /> : <ResourceSession key={ticket} ticket={ticket} onExpired={onExpired} />;
}

function ResourceSession({ ticket, onExpired }: { ticket: string; onExpired: (notice?: Notice) => void }) {
  const { t, errorText } = useI18n();
  const { page, failure, slow, read, act, cardAsks } = usePlayerPage(ticket, onExpired);
  const slowNote = slow && <p className="session-subtitle text-center" role="status">{t("网络较慢，正在重试")}</p>;
  if (!page && failure)
    return (
      <section className="machine-session session-status">
        <StatusView heading icon="failed" tone="error" title={t("无法进入机台会话")} detail={errorText(failure)}>
          <button className="session-action" onClick={() => void read()}>{t("重试")}</button>
        </StatusView>
      </section>
    );
  if (!page)
    return (
      <section className="machine-session session-status" aria-busy="true" role="status" aria-label={t("正在加载")}>
        <Loader2 size={28} className="animate-spin" aria-hidden="true" />
        {slowNote}
      </section>
    );
  return (
    <section className="machine-session">
      <ShopHero name={page.shop} heroUrl={page.heroUrl} subtitle={page.resource} />
      {slowNote}
      <PlayerPageBlocks page={page} ticket={ticket} act={act} read={read} cardAsks={cardAsks} onExpired={onExpired} />
    </section>
  );
}

function ResourceExpiredPage({ notice }: { notice?: Notice }) {
  const { t } = useI18n();
  return (
    <section className="machine-session session-status">
      <StatusView heading icon="expired" title={notice?.title ?? t("本次会话已失效")} detail={notice?.body ?? t("请重新碰一下 NFC 或重新扫描二维码。")} />
    </section>
  );
}
