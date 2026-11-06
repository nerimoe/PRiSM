import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, Coins, DoorOpen, Info, Loader2, Plus, Power, XCircle } from "lucide-react";
import { Api, ApiError, type Card, type Notice } from "../api";
import { useI18n } from "../i18n";
import { billTime } from "./bill-time";
import { operationLocation } from "./BillingPages";
import { PlayerClimate, type ClimateState } from "./ClimateControls";
import { useInlineNotice, useNotice } from "./NoticeProvider";
import type { ActionAnswer, Page, PageButton, PageCards, PageCode } from "./player-page";
import { ResourcePricing, type ResourceRules } from "./ResourcePricing";
import { PlatformBinding, SessionSignIn } from "./SessionContent";
import { SessionPasskeySetup } from "./SessionPasskeySetup";

type Act = (action: string, payload: Record<string, unknown> | undefined, needsLocation: boolean) => Promise<ActionAnswer>;

const ICONS = { coin: Coins, power: Power, door: DoorOpen };
/** How long a power-on waits for the machine to report on before the button comes back. */
const POWER_ON_WAIT_MS = 15_000;

function NoticeIcon({ level, size }: { level: Notice["level"]; size: number }) {
  const Icon = level === "success" ? CheckCircle2 : level === "error" ? XCircle : level === "info" ? Info : AlertCircle;
  return <Icon size={size} aria-hidden="true" />;
}

function InlineNoticeLine({ note }: { note: Notice }) {
  return <p className="inline-notice" data-level={note.level} role="status"><NoticeIcon level={note.level} size={18} />{note.body}</p>;
}

const localNote = (body: string): Notice =>
  ({ code: "CLIENT", level: "warning", display: "inline", flow: "none", title: null, body, actions: [] });

/** Draws the page. Only what the player is in the middle of is kept here. */
export function PlayerPageBlocks({ page, ticket, act, read, onExpired }: {
  page: Page;
  ticket: string;
  act: Act;
  read: () => Promise<void>;
  onExpired: () => void;
}) {
  const { t } = useI18n();
  const showNotice = useNotice();
  const [busy, setBusy] = useState("");
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const [code, setCode] = useState<PageCode | null>(null);
  const [waitingPower, setWaitingPower] = useState(false);
  const [cardsBusy, setCardsBusy] = useState(false);
  const [addingCard, setAddingCard] = useState(false);
  const [note, showNote] = useInlineNotice();
  const [noteAt, setNoteAt] = useState("");
  const noteUnder = (id: string) => (note && noteAt === id ? <InlineNoticeLine note={note} /> : null);
  const showAt = useCallback((id: string, next: Notice) => { setNoteAt(id); showNote(next); }, [showNote]);
  const handlers = { onExpired, onRefresh: () => void read() };

  const hasConsent = page.blocks.some((block) => block.kind === "consent");
  const powerOffered = page.blocks.some((block) => block.kind === "button" && block.action === "power.on");
  // Coming back to confirming later starts unticked.
  useEffect(() => { if (!hasConsent) setAgreed({}); }, [hasConsent]);
  useEffect(() => { if (!powerOffered) setWaitingPower(false); }, [powerOffered]);
  useEffect(() => {
    if (!waitingPower) return;
    const timer = setTimeout(() => {
      setWaitingPower(false);
      showAt("power", localNote(t("未检测到开机，请重试")));
    }, POWER_ON_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waitingPower, showAt, t]);
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(null), Math.max(0, Date.parse(code.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);

  const blocked = !!busy || cardsBusy;

  async function run(id: string, action: string, payload: Record<string, unknown> | undefined, needsLocation: boolean) {
    if (blocked) return;
    setBusy(action);
    if (noteAt === id) showNote(null);
    try {
      const answer = await act(action, payload, needsLocation);
      for (const notice of answer.notices) {
        if (notice.display === "inline") showAt(id, notice);
        else showNotice(notice, handlers);
      }
      if (answer.code) setCode(answer.code);
      if (action === "power.on" && answer.ok && answer.page.blocks.some((block) => block.kind === "button" && block.action === "power.on"))
        setWaitingPower(true);
    } catch (caught) {
      const notice = showNotice(caught, handlers);
      if (notice.display === "inline") showAt(id, notice);
    } finally {
      setBusy("");
    }
  }

  const press = (block: PageButton) =>
    run(block.id, block.action, block.requires ? { ...block.payload, consent: true } : block.payload, block.needsLocation);

  if (page.blocks[0]?.kind === "signin") return <SessionSignIn />;

  const drawn = (
    <div className="device-controls">
      {page.blocks.map((block) => {
        switch (block.kind) {
          case "text":
            if (block.style === "heading") return <h2 key={block.id}>{block.text}</h2>;
            if (block.level === "error") return <p key={block.id} role="alert" className="text-sm text-coral">{block.text}</p>;
            return <p key={block.id} className="session-subtitle text-center">{block.text}</p>;
          case "binding":
            return <PlatformBinding key={block.id} code={page.shopCode} />;
          case "pricing":
            return <ResourcePricing key={block.id} rules={block.rules as ResourceRules} changes={(block.changes ?? undefined) as Parameters<typeof ResourcePricing>[0]["changes"]} />;
          case "consent":
            return (
              <label key={block.id} className="flex items-start gap-3 text-sm leading-relaxed">
                <input
                  className="mt-1 shrink-0"
                  type="checkbox"
                  checked={!!agreed[block.id]}
                  onChange={(event) => setAgreed((current) => ({ ...current, [block.id]: event.target.checked }))}
                />
                <span>{block.text}</span>
              </label>
            );
          case "climate":
            return (
              <div key={block.id} className="grid gap-3">
                <PlayerClimate
                  state={block.state as ClimateState | null}
                  busy={busy.startsWith("climate.") ? busy : ""}
                  blocked={blocked}
                  send={(action, extra) => void run(block.id, action, extra, block.needsLocation)}
                />
                {noteUnder(block.id)}
              </div>
            );
          case "mahjong":
            return (
              <section key={block.id} className="mahjong-table">
                <header className="mahjong-heading">
                  <div><h2>{block.title}</h2><p>{block.status}</p></div>
                  <span className="mahjong-count">{block.seats.length}<span> / {block.capacity}</span></span>
                </header>
                <ul className="mahjong-seats">
                  {Array.from({ length: block.capacity }, (_, index) => {
                    const seat = block.seats[index];
                    return (
                      <li className={`mahjong-seat${seat?.mine ? " is-mine" : ""}${!seat ? " is-empty" : ""}`} key={index}>
                        <span className="mahjong-seat-name">{seat?.name || block.emptyLabel}</span>
                        {seat?.mine && <span className="mahjong-self">{block.mineLabel}</span>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          case "cards":
            return (
              <PlayerCards
                key={block.id}
                block={block}
                resource={page.resource}
                ticket={ticket}
                act={act}
                blocked={!!busy}
                onExpired={onExpired}
                onRefresh={handlers.onRefresh}
                onBusy={setCardsBusy}
                onAdding={setAddingCard}
              />
            );
          case "button": {
            // Adding a card takes the place of what is done with one.
            if (addingCard && block.icon === "coin") return null;
            const Icon = block.icon ? ICONS[block.icon] : null;
            const pressing = busy === block.action || (block.action === "power.on" && waitingPower);
            const onButton = block.answerOnButton && noteAt === block.id ? note : null;
            const label = block.enabled && onButton ? onButton.body : code && block.againLabel ? block.againLabel : block.label;
            return (
              <div key={block.id} className="grid gap-3">
                {code && block.againLabel && (
                  <div className="door-password">
                    <h2>{code.title}</h2>
                    <output className="select-all">{code.value}</output>
                    <small>{code.expiresLabel} {billTime(code.expiresAt).time}</small>
                    <p>{code.hint}</p>
                  </div>
                )}
                <button
                  className={`session-action${block.style === "primary" ? " primary" : ""}`}
                  data-level={onButton?.level}
                  disabled={blocked || pressing || !block.enabled || (!!block.requires && !agreed[block.requires])}
                  aria-live={block.answerOnButton ? "polite" : undefined}
                  onClick={() => void press(block)}
                >
                  {pressing ? <Loader2 size={22} className="animate-spin" />
                    : onButton ? <NoticeIcon level={onButton.level} size={22} />
                    : Icon ? <Icon size={22} /> : null}{" "}
                  {label}
                </button>
                {!block.answerOnButton && noteUnder(block.id)}
              </div>
            );
          }
          default:
            // A kind this version does not know yet.
            return null;
        }
      })}
    </div>
  );
  // Binding a passkey is offered once there is something to protect.
  return page.blocks[0]?.kind === "text" && page.blocks[0].id === "empty" ? drawn : <SessionPasskeySetup>{drawn}</SessionPasskeySetup>;
}

function FeedbackIcon({ level }: { level: Notice["level"] }) {
  const Icon = level === "success" ? CheckCircle2 : level === "error" ? XCircle : AlertCircle;
  return <Icon size={24} className="credential-feedback-icon" aria-hidden="true" />;
}

/** The player's cards, swiping one, and adding one at the reader. They are not part of the page: they are read here. */
function PlayerCards({ block, resource, ticket, act, blocked, onExpired, onRefresh, onBusy, onAdding }: {
  block: PageCards;
  resource: string;
  ticket: string;
  act: Act;
  blocked: boolean;
  onExpired: () => void;
  onRefresh: () => void;
  onBusy: (busy: boolean) => void;
  onAdding: (adding: boolean) => void;
}) {
  const { t, errorText } = useI18n();
  const showNotice = useNotice();
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [swiping, setSwiping] = useState<string | null>(null);
  /** A swipe's outcome on its row: the card's part, then the coin's, each with its own level. */
  const [feedback, setFeedback] = useState<{ cardId: string; parts: Pick<Notice, "level" | "body">[] } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [capture, setCapture] = useState<
    | { phase: "starting" | "waiting" }
    | { phase: "done"; level: "success" | "error"; message: string }
    | null
  >(null);
  const captureRun = useRef(0);
  const capturing = capture?.phase === "starting" || capture?.phase === "waiting";

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setLoading(true);
    Api.cards()
      .then((result) => { if (!cancelled) setCards(result.cards.filter((card) => !card.disabledAt)); })
      .catch((caught) => { if (!cancelled) setLoadError(caught instanceof ApiError ? caught.message : "请检查网络后重试"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [version]);

  useEffect(() => { onBusy(!!swiping || capturing); }, [swiping, capturing, onBusy]);
  useEffect(() => { onAdding(!!capture); }, [capture, onAdding]);
  useEffect(() => () => {
    captureRun.current += 1;
    clearTimeout(feedbackTimer.current);
    onBusy(false);
    onAdding(false);
  }, [onBusy, onAdding]);

  /** Shown for a few seconds; the page stays usable meanwhile. */
  const showFeedback = (next: typeof feedback) => {
    clearTimeout(feedbackTimer.current);
    setFeedback(next);
    if (next) feedbackTimer.current = setTimeout(() => setFeedback(null), next.parts[0]?.level === "success" ? 3000 : 5000);
  };

  const swipe = async (cardId: string) => {
    if (swiping || blocked) return;
    setSwiping(cardId);
    showFeedback(null);
    try {
      const answer = await act(block.action, { cardId }, block.needsLocation);
      // The row carries the outcome; only a problem that needs the player interrupts.
      const inline = answer.notices.filter((notice) => notice.display === "inline");
      if (inline.length) showFeedback({ cardId, parts: inline });
      for (const notice of answer.notices) if (notice.display !== "inline") showNotice(notice, { onExpired, onRefresh });
      // A refused swipe may mean the card is gone.
      if (!answer.ok) setVersion((value) => value + 1);
    } catch (caught) {
      const notice = showNotice(caught, { onExpired, onRefresh, retry: () => void swipe(cardId) });
      if (notice.display === "inline") showFeedback({ cardId, parts: [notice] });
    } finally {
      setSwiping(null);
    }
  };

  /** Opens a short window and waits for the reader to report the card. A newer attempt or a cancel stops an older one waiting. */
  const startCapture = async () => {
    const run = ++captureRun.current;
    const current = () => captureRun.current === run;
    setCapture({ phase: "starting" });
    try {
      const location = await operationLocation(block.needsLocation);
      const started = await Api.startCardCapture({ ticket, location });
      if (!current()) return;
      setCapture({ phase: "waiting" });
      const deadline = Date.parse(started.expiresAt) + 2000;
      let status: Awaited<ReturnType<typeof Api.cardCaptureResult>>["status"] = "waiting";
      while (status === "waiting" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!current()) return;
        status = (await Api.cardCaptureResult(started.captureId, ticket)).status;
      }
      if (!current()) return;
      const added = status === "added" || status === "bound" || status === "exists";
      setCapture({
        phase: "done",
        level: added ? "success" : "error",
        message: t(
          added ? "已添加卡片"
            : status === "taken" ? "这张卡已绑定到本店的其他玩家"
            : status === "unsupported" ? "不支持这种卡片"
            : "没有读到卡片",
        ),
      });
      if (added) setVersion((value) => value + 1);
    } catch (caught) {
      if (current()) setCapture({ phase: "done", level: "error", message: caught instanceof Error ? errorText(caught.message) : t("请检查网络后重试") });
    }
  };

  const disabled = !block.enabled || blocked || !!swiping;
  return (
    <section>
      <div className="session-task device-card-heading">
        <h2>{t(capture ? "添加卡片" : "选择卡片")}</h2>
        {!capture && block.capture && (
          <button type="button" className="card-capture-add" aria-label={t("添加卡片")} disabled={disabled} onClick={() => void startCapture()}>
            <Plus size={22} aria-hidden="true" />
          </button>
        )}
      </div>
      {capture ? (
        <div className="card-capture" role="status" aria-live="polite">
          {capturing ? (
            <>
              <Loader2 size={28} className="animate-spin text-mint" aria-hidden="true" />
              <p className="session-subtitle">{capture.phase === "starting" ? t("正在连接机台…") : t("请把卡片放在「{name}」的读卡器上", { name: resource })}</p>
              <button type="button" className="session-action" onClick={() => { captureRun.current += 1; setCapture(null); }}>{t("取消")}</button>
            </>
          ) : capture.phase === "done" ? (
            <>
              <FeedbackIcon level={capture.level} />
              <p className="session-subtitle">{capture.message}</p>
              <button type="button" className="session-action" onClick={() => setCapture(null)}>{t("完成")}</button>
            </>
          ) : null}
        </div>
      ) : (
        <fieldset disabled={disabled}>
          {loading ? (
            <div className="flex justify-center" role="status" aria-label={t("正在加载卡片")}>
              <Loader2 size={28} className="animate-spin" aria-hidden="true" />
            </div>
          ) : loadError ? (
            <div className="text-center" role="status">
              <h2 className="text-xl font-semibold">{t("无法加载卡片")}</h2>
              <p className="session-subtitle">{errorText(loadError)}</p>
              <button className="session-action mt-6 w-full" onClick={() => setVersion((value) => value + 1)}>{t("重新加载卡片")}</button>
            </div>
          ) : cards.length ? (
            <div className="credential-list">
              {cards.map((card) => {
                const active = swiping === card.id;
                const done = feedback?.cardId === card.id ? feedback : null;
                return (
                  <button
                    key={card.id}
                    className="credential-row"
                    disabled={disabled}
                    data-active={active}
                    data-feedback={done ? done.parts[0]?.level : undefined}
                    onClick={() => void swipe(card.id)}
                  >
                    <span className="min-w-0">
                      <span className="credential-name">{card.label}</span>
                      <span className="credential-detail" aria-live={active ? "polite" : "off"}>
                        {done
                          ? done.parts.map((part, index) => <span key={index} className="credential-feedback-part" data-level={part.level}>{part.body}</span>)
                          : active ? t("正在登录…") : t("尾号 {digits}", { digits: card.accessCode.slice(-4) })}
                      </span>
                    </span>
                    {done ? <FeedbackIcon level={done.parts[0]?.level ?? "success"} />
                      : active ? <Loader2 size={20} className="animate-spin text-mint" />
                      : <ChevronRight size={20} className="text-ink/30" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-center">
              <p className="session-subtitle">{t("还没有可用卡片，请先在 PRiSM 添加卡片")}</p>
              <a className="session-action mt-4 w-full" href="/cards" target="_blank" rel="noopener noreferrer">{t("添加卡片")}</a>
              <button className="session-action mt-6 w-full" onClick={() => setVersion((value) => value + 1)}>{t("重新加载卡片")}</button>
            </div>
          )}
        </fieldset>
      )}
    </section>
  );
}
