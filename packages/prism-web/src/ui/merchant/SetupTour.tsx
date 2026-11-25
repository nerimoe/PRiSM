import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Compass,
  Minimize2,
  MousePointerClick,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { BillingExplainer } from "./BillingExplainer";
import { GuideDiagram } from "./GuideDiagrams";
import type { SetupStatus } from "./setup-guide";
import {
  buildTourSteps,
  findTourStepIndex,
  isStepDone,
  tourRouteParts,
  type TourStep,
  type TourStepId,
} from "./setup-tour";
import { Modal, button, buttonQuiet } from "./shared";
import { SetupTourContext, useSetupTour, type TourStartOptions } from "./tour-context";

type PersistedTour = {
  stepId: TourStepId;
  minimized: boolean;
};

const tourStorageKey = (shopCode: string) => `prism.setup.tour.${shopCode}`;

function readTourState(shopCode: string): PersistedTour | null {
  try {
    const raw = window.sessionStorage.getItem(tourStorageKey(shopCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedTour>;
    if (!parsed || typeof parsed.stepId !== "string") return null;
    return {
      stepId: parsed.stepId as TourStepId,
      minimized: Boolean(parsed.minimized),
    };
  } catch {
    return null;
  }
}

function writeTourState(shopCode: string, state: PersistedTour | null) {
  try {
    const key = tourStorageKey(shopCode);
    if (state) window.sessionStorage.setItem(key, JSON.stringify(state));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Session persistence is optional; ignore storage restrictions.
  }
}

export function SetupTourProvider({
  shopCode,
  status,
  reload,
  enabled,
  children,
}: {
  shopCode: string;
  status: SetupStatus | null;
  reload: () => Promise<void>;
  enabled: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<PersistedTour | null>(() =>
    enabled ? readTourState(shopCode) : null,
  );
  const [modalCount, setModalCount] = useState(0);
  const activeRef = useRef(false);
  const lastNavigatedRef = useRef<string | null>(null);

  useEffect(() => {
    setState(enabled ? readTourState(shopCode) : null);
    lastNavigatedRef.current = null;
  }, [shopCode, enabled]);

  const steps = useMemo(() => (status ? buildTourSteps(status) : []), [status]);
  const active = enabled && !!status && !!state && steps.length > 0;
  activeRef.current = active;

  const stepIndex = useMemo(() => {
    if (!state || !steps.length) return 0;
    const idx = steps.findIndex((step) => step.id === state.stepId);
    return idx >= 0 ? idx : 0;
  }, [state, steps]);

  const currentStep = active ? (steps[stepIndex] ?? null) : null;
  const minimized = !!state?.minimized;

  const commitState = useCallback(
    (next: PersistedTour | null) => {
      setState(next);
      writeTourState(shopCode, next);
    },
    [shopCode],
  );

  // Navigate automatically whenever a step becomes active or the tour resumes.
  useEffect(() => {
    if (!active || minimized || !currentStep) {
      if (!active || minimized) lastNavigatedRef.current = null;
      return;
    }
    const navKey = `${shopCode}:${currentStep.id}`;
    if (lastNavigatedRef.current === navKey) return;
    lastNavigatedRef.current = navKey;
    const target = tourRouteParts(shopCode, currentStep.route);
    if (location.pathname !== target.pathname || location.search !== target.search) {
      navigate(target.full, { replace: true });
    }
  }, [active, minimized, currentStep, shopCode, location.pathname, location.search, navigate]);

  const start = useCallback(
    (options?: TourStartOptions) => {
      if (!enabled || !status || !steps.length) return;
      const idx = findTourStepIndex(steps, { ...options, status });
      const chosen = steps[idx] ?? steps[0]!;
      lastNavigatedRef.current = null;
      commitState({ stepId: chosen.id, minimized: false });
    },
    [enabled, status, steps, commitState],
  );

  const goTo = useCallback(
    (index: number) => {
      if (!steps.length) return;
      const clamped = Math.min(Math.max(0, index), steps.length - 1);
      lastNavigatedRef.current = null;
      commitState({ stepId: steps[clamped]!.id, minimized: false });
    },
    [steps, commitState],
  );

  const next = useCallback(() => {
    if (!steps.length) return;
    if (stepIndex < steps.length - 1) {
      lastNavigatedRef.current = null;
      commitState({ stepId: steps[stepIndex + 1]!.id, minimized: false });
      return;
    }
    lastNavigatedRef.current = null;
    commitState(null);
    navigate(`/merchant/${encodeURIComponent(shopCode)}/guide`, { replace: true });
  }, [steps, stepIndex, commitState, navigate, shopCode]);

  const prev = useCallback(() => {
    if (!steps.length || stepIndex <= 0) return;
    lastNavigatedRef.current = null;
    commitState({ stepId: steps[stepIndex - 1]!.id, minimized: false });
  }, [steps, stepIndex, commitState]);

  const minimize = useCallback(() => {
    if (!state) return;
    commitState({ ...state, minimized: true });
  }, [state, commitState]);

  const resume = useCallback(() => {
    if (!state) return;
    lastNavigatedRef.current = null;
    commitState({ ...state, minimized: false });
  }, [state, commitState]);

  const stop = useCallback(() => {
    lastNavigatedRef.current = null;
    commitState(null);
  }, [commitState]);

  const registerModal = useCallback(() => {
    setModalCount((count) => count + 1);
    return () => {
      setModalCount((count) => Math.max(0, count - 1));
      if (activeRef.current) {
        void reload();
      }
    };
  }, [reload]);

  const value = useMemo(
    () => ({
      active,
      minimized,
      steps,
      stepIndex,
      currentStep,
      modalCount,
      start,
      next,
      prev,
      goTo,
      minimize,
      resume,
      stop,
      registerModal,
    }),
    [
      active,
      minimized,
      steps,
      stepIndex,
      currentStep,
      modalCount,
      start,
      next,
      prev,
      goTo,
      minimize,
      resume,
      stop,
      registerModal,
    ],
  );

  return (
    <SetupTourContext.Provider value={value}>
      {children}
      <SetupTourOverlay shopCode={shopCode} status={status} />
    </SetupTourContext.Provider>
  );
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

function isElementVisible(el: Element): boolean {
  if (el instanceof HTMLElement && el.closest("[hidden]")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function findTourTarget(step: TourStep): Element | null {
  const selectors = [step.target, step.fallbackTarget]
    .filter((value): value is string => Boolean(value))
    .map((value) => `[data-tour="${CSS.escape(value)}"]`);
  for (const selector of selectors) {
    const candidates = document.querySelectorAll(selector);
    for (const candidate of candidates) {
      if (isElementVisible(candidate)) return candidate;
    }
  }
  return null;
}

function readRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 1 &&
    Math.abs(a.top - b.top) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}

function computeDesktopCardStyle(
  rect: Rect | null,
  viewport: { width: number; height: number },
  cardHeight: number,
): { left: number; top: number; width: number } {
  const margin = 16;
  const gap = 16;
  const width = Math.min(392, Math.max(280, viewport.width - margin * 2));
  const height = Math.min(cardHeight || 430, viewport.height - margin * 2);
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const maxTop = Math.max(margin, viewport.height - height - margin);
  const clamp = (left: number, top: number) => ({
    left: Math.min(Math.max(margin, left), maxLeft),
    top: Math.min(Math.max(margin, top), maxTop),
    width,
  });

  if (!rect) return clamp(maxLeft, maxTop);
  const largeTarget =
    rect.width > viewport.width * 0.65 && rect.height > viewport.height * 0.6;
  if (largeTarget) return clamp(maxLeft, maxTop);

  if (rect.right + gap + width <= viewport.width - margin) {
    return clamp(rect.right + gap, rect.top);
  }
  if (rect.left - gap - width >= margin) {
    return clamp(rect.left - gap - width, rect.top);
  }
  if (rect.bottom + gap + height <= viewport.height - margin) {
    return clamp(rect.left, rect.bottom + gap);
  }
  if (rect.top - gap - height >= margin) {
    return clamp(rect.left, rect.top - gap - height);
  }
  return clamp(maxLeft, maxTop);
}

function SetupTourOverlay({
  shopCode,
  status,
}: {
  shopCode: string;
  status: SetupStatus | null;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    active,
    minimized,
    steps,
    stepIndex,
    currentStep,
    modalCount,
    next,
    prev,
    minimize,
    resume,
    stop,
  } = useSetupTour();

  const maskId = useId();
  const cardRef = useRef<HTMLElement | null>(null);
  const scrolledKeyRef = useRef<string | null>(null);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 800,
  }));
  const [cardHeight, setCardHeight] = useState(430);
  const [manualOpen, setManualOpen] = useState(false);

  const visible = active && !minimized && modalCount === 0 && !!currentStep && !!status;
  const targetRoute = currentStep ? tourRouteParts(shopCode, currentStep.route) : null;
  const offRoute = Boolean(
    visible &&
      targetRoute &&
      (location.pathname !== targetRoute.pathname ||
        (targetRoute.search && location.search !== targetRoute.search)),
  );

  // Measure target element & keep spotlight aligned on resize, scroll, or DOM updates.
  useEffect(() => {
    if (!visible || !currentStep) {
      setTargetRect(null);
      return;
    }

    let raf = 0;
    let resizeObserver: ResizeObserver | null = null;
    let observedTarget: Element | null = null;

    const update = () => {
      raf = 0;
      setViewport((current) =>
        current.width === window.innerWidth && current.height === window.innerHeight
          ? current
          : { width: window.innerWidth, height: window.innerHeight },
      );

      const el = findTourTarget(currentStep);
      if (el && currentStep.expandDetails && el instanceof HTMLDetailsElement && !el.open) {
        el.open = true;
      }

      if (el !== observedTarget) {
        resizeObserver?.disconnect();
        observedTarget = el;
        if (el && typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(schedule);
          resizeObserver.observe(el);
        }
      }

      if (!el) {
        setTargetRect((prevRect) => (prevRect === null ? null : null));
        return;
      }

      const nextRect = readRect(el);
      const scrollKey = `${currentStep.id}:${currentStep.route}`;
      if (scrolledKeyRef.current !== scrollKey) {
        scrolledKeyRef.current = scrollKey;
        const topMargin = 80;
        const bottomMargin = window.innerWidth < 640 ? 280 : 120;
        if (nextRect.top < topMargin || nextRect.bottom > window.innerHeight - bottomMargin) {
          el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        }
      }

      setTargetRect((prevRect) => (rectsEqual(prevRect, nextRect) ? prevRect : nextRect));
    };

    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };

    update();
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "style", "class", "open", "data-tour"],
    });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", schedule, true);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [visible, currentStep]);

  useEffect(() => {
    if (!visible) scrolledKeyRef.current = null;
  }, [visible, currentStep?.id]);

  useLayoutEffect(() => {
    if (!visible || !cardRef.current) return;
    const height = cardRef.current.getBoundingClientRect().height;
    if (height > 0) setCardHeight(height);
  }, [visible, currentStep?.id, targetRect, viewport.width]);

  // Keyboard navigation while spotlight card is visible.
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "Escape") stop();
      else if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowLeft" && stepIndex > 0) prev();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, stepIndex, next, prev, stop]);

  if (!active || !currentStep || !status) return null;

  if (minimized) {
    return (
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 rounded-full border border-tour/50 bg-panel p-1.5 pl-3.5 shadow-soft">
        <Compass size={16} className="shrink-0 text-tour" aria-hidden="true" />
        <button
          type="button"
          className="focus-ring rounded-full px-1.5 py-1 text-xs font-semibold text-ink hover:text-tour"
          onClick={resume}
        >
          {t("继续引导 ({current}/{total})", {
            current: stepIndex + 1,
            total: steps.length,
          })}
        </button>
        <button
          type="button"
          className="focus-ring grid size-7 place-items-center rounded-full text-ink/50 hover:bg-ink/5 hover:text-ink"
          aria-label={t("退出引导")}
          onClick={stop}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <>
      {visible && (
        <>
          {targetRect && (
            <>
              <svg
                className="pointer-events-none fixed inset-0 z-40 h-full w-full"
                aria-hidden="true"
              >
                <defs>
                  <mask id={maskId}>
                    <rect width="100%" height="100%" fill="white" />
                    <rect
                      x={Math.max(0, targetRect.left - 6)}
                      y={Math.max(0, targetRect.top - 6)}
                      width={targetRect.width + 12}
                      height={targetRect.height + 12}
                      rx={14}
                      fill="black"
                    />
                  </mask>
                </defs>
                <rect
                  width="100%"
                  height="100%"
                  fill="rgba(10, 14, 22, 0.46)"
                  mask={`url(#${maskId})`}
                />
              </svg>
              <div
                aria-hidden="true"
                className="tour-spotlight-ring pointer-events-none fixed z-40 rounded-[14px]"
                style={{
                  left: targetRect.left - 6,
                  top: targetRect.top - 6,
                  width: targetRect.width + 12,
                  height: targetRect.height + 12,
                }}
              >
                <span
                  className={`tour-pointer-tag absolute left-0 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    targetRect.top < 38 ? "top-2 left-2" : "-top-7"
                  }`}
                >
                  <MousePointerClick size={12} aria-hidden="true" />
                  {t("指引目标")}
                </span>
              </div>
            </>
          )}

          <aside
            ref={cardRef}
            role="region"
            aria-label={t("开店互动引导")}
            className="pointer-events-auto fixed z-50 flex max-h-[72dvh] flex-col gap-3 overflow-y-auto rounded-2xl border border-tour/45 bg-panel p-4 shadow-xl max-sm:inset-x-3 max-sm:bottom-3 sm:max-h-[calc(100dvh-2rem)]"
            style={
              viewport.width >= 640
                ? computeDesktopCardStyle(targetRect, viewport, cardHeight)
                : undefined
            }
          >
            <header className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded-full bg-tour/15 px-2 py-0.5 font-semibold text-tour">
                    {t(currentStep.chapter)}
                  </span>
                  <span className="tabular-nums text-ink/50">
                    {stepIndex + 1} / {steps.length}
                  </span>
                  {isStepDone(currentStep, status) && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-[#23815d] dark:text-emerald-400">
                      <CheckCircle2 size={11} aria-hidden="true" />
                      {t("已完成")}
                    </span>
                  )}
                </div>
                <h3 className="mt-1.5 text-base font-semibold leading-snug text-ink">
                  {t(currentStep.title)}
                </h3>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={minimize}
                  className="focus-ring grid size-7 place-items-center rounded-lg text-ink/50 hover:bg-ink/5 hover:text-ink"
                  title={t("暂时收起")}
                  aria-label={t("暂时收起")}
                >
                  <Minimize2 size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={stop}
                  className="focus-ring grid size-7 place-items-center rounded-lg text-ink/50 hover:bg-ink/5 hover:text-ink"
                  title={t("退出引导")}
                  aria-label={t("退出引导")}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="h-1 w-full overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
              <div
                className="h-full rounded-full bg-tour transition-[width] duration-200"
                style={{ width: `${Math.round(((stepIndex + 1) / steps.length) * 100)}%` }}
              />
            </div>

            <GuideDiagram id={currentStep.diagram} mode={status.mode} compact />

            <p className="text-xs leading-relaxed text-ink/70">{t(currentStep.concept)}</p>

            <div className="flex items-start gap-2 rounded-xl border border-tour/35 bg-tour/[0.08] px-3 py-2 text-xs leading-relaxed text-ink">
              <MousePointerClick size={14} className="mt-0.5 shrink-0 text-tour" aria-hidden="true" />
              <span>{t(currentStep.action)}</span>
            </div>

            {offRoute && targetRoute && (
              <button
                type="button"
                className={`${buttonQuiet} justify-start px-2 py-1 text-xs text-tour`}
                onClick={() => navigate(targetRoute.full)}
              >
                {t("回到本步所在页面")}
              </button>
            )}

            {currentStep.showBillingManual && (
              <button
                type="button"
                className={`${buttonQuiet} justify-start px-2 py-1 text-xs text-ink/75`}
                onClick={() => setManualOpen(true)}
              >
                <BookOpen size={13} aria-hidden="true" />
                {t("查看完整计费图解说明书")}
              </button>
            )}

            <footer className="mt-0.5 flex items-center justify-between gap-2 border-t border-ink/10 pt-2.5">
              <button
                type="button"
                disabled={stepIndex === 0}
                onClick={prev}
                className={`${button} !min-h-9 !rounded-xl !px-3 !py-1.5 !text-xs`}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                {t("上一步")}
              </button>
              <button
                type="button"
                onClick={next}
                className={`${button} tour-btn !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs`}
              >
                {t(stepIndex === steps.length - 1 ? "完成引导" : "下一步")}
                {stepIndex < steps.length - 1 && <ArrowRight size={14} aria-hidden="true" />}
              </button>
            </footer>
          </aside>
        </>
      )}

      {manualOpen && (
        <Modal title="计费说明书" close={() => setManualOpen(false)} xl>
          <BillingExplainer />
        </Modal>
      )}
    </>
  );
}
