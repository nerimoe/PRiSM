import { createContext, useContext, useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { SetupStepId } from "./setup-guide";
import type { TourStep, TourStepId } from "./setup-tour";

export type TourStartOptions = {
  stepId?: TourStepId;
  setupStep?: SetupStepId;
  fromIncomplete?: boolean;
};

export type SetupTourContextValue = {
  active: boolean;
  minimized: boolean;
  steps: TourStep[];
  stepIndex: number;
  currentStep: TourStep | null;
  modalCount: number;
  start: (options?: TourStartOptions) => void;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  minimize: () => void;
  resume: () => void;
  stop: () => void;
  registerModal: () => () => void;
};

const noop = () => {};

export const SetupTourContext = createContext<SetupTourContextValue>({
  active: false,
  minimized: false,
  steps: [],
  stepIndex: 0,
  currentStep: null,
  modalCount: 0,
  start: noop,
  next: noop,
  prev: noop,
  goTo: noop,
  minimize: noop,
  resume: noop,
  stop: noop,
  registerModal: () => noop,
});

export const useSetupTour = () => useContext(SetupTourContext);

/**
 * Registers an open merchant `<Modal>` with the active tour so the full-page
 * spotlight yields to native `<dialog>` top-layer rendering and refreshes setup
 * progress as soon as the modal closes.
 */
export function useRegisterTourModal() {
  const { registerModal } = useSetupTour();
  useEffect(() => registerModal(), [registerModal]);
}

/**
 * Contextual banner rendered inside `<Modal>` when the active tour step defines
 * a `modalHint`. Gives the merchant exact guidance inside the form dialog.
 */
export function TourModalBanner() {
  const { t } = useI18n();
  const { active, minimized, currentStep } = useSetupTour();
  const [dismissedId, setDismissedId] = useState<TourStepId | null>(null);
  const hint = active && !minimized ? currentStep?.modalHint : undefined;
  if (!hint || !currentStep || dismissedId === currentStep.id) return null;
  return (
    <div
      role="note"
      className="flex items-start gap-3 border-b border-tour/30 bg-tour/[0.09] px-5 py-3 text-sm"
    >
      <Sparkles size={16} className="mt-0.5 shrink-0 text-tour" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">{t(hint.title)}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink/70">{t(hint.body)}</p>
      </div>
      <button
        type="button"
        onClick={() => setDismissedId(currentStep.id)}
        className="focus-ring grid size-7 shrink-0 place-items-center rounded-lg text-ink/50 hover:bg-ink/5 hover:text-ink"
        aria-label={t("收起提示")}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
