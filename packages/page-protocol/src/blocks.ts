/**
 * What a scanned page is made of. This is the one definition both the platform,
 * which generates pages, and the web client, which draws them, compile against;
 * the App Clip mirrors it in `PrismPage.swift`. `docs/player-page.md` has what
 * clients must do with it.
 *
 * Clients skip a `kind` they do not know, and match blocks by `id` from one read
 * to the next so what the player is in the middle of (a ticked box, a form
 * field, a spinner) survives. Text is already in the player's language.
 */

/** A localized interaction instruction from the server, also cached for client-side failures. */
export type PageNotice = {
  code: string;
  level: "success" | "info" | "error";
  display: "dialog" | "inline" | "none";
  presentation?: "page" | "status" | "field" | "control" | "toast";
  flow: "none" | "expired" | "refresh" | "signin";
  title: string | null;
  body: string;
  actions: { kind: "dismiss" | "retry" | "refresh" | "settings"; label: string }[];
  /** Field block that owns validation feedback. */
  fieldId?: string;
  /** null keeps the message until updated; missing supports older servers. */
  durationMs?: number | null;
  /** Hold a button result and disable that button for this long. Card errors can stay longer. */
  controlDurationMs?: number;
};

/** What a climate entity is doing and what it offers. */
export type ClimateState = {
  /** `off`, or the running HVAC mode such as `cool`, `heat`, `dry`, `fan_only`, `auto`. */
  mode: string;
  modes: string[];
  temperature: number | null;
  currentTemperature: number | null;
  minTemperature: number | null;
  maxTemperature: number | null;
  temperatureStep: number | null;
  fanMode: string | null;
  fanModes: string[];
};

export type PageTone = "default" | "muted" | "accent" | "success" | "warning" | "error" | "purple";

export type PageKeyValueIcon = "wallet" | "gift" | "coins" | "coupon" | "pass" | "ticket" | "asset";

/** The picture over a `status` text: what state the page is in, drawn by each client its own way. */
export type PageStatusIcon =
  | "blocked"
  | "waiting"
  | "scan"
  | "empty"
  | "unavailable"
  | "receipt"
  | "wallet"
  | "identity"
  | "options";

export type PageButtonIcon =
  | "coin"
  | "power"
  | "door"
  | "plus"
  | "refresh"
  | "check"
  | "lock"
  | "info"
  | "warning"
  | "close"
  | "arrow-right";

export type PageButtonStyle = "primary" | "destructive";

export type PageButtonConfirm = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
};

export type PageButtonWait = { ms: number; timeoutMessage: string; notice?: PageNotice };

export type PageButton = {
  kind: "button";
  id: string;
  label: string;
  /** Replaces `label` once the action has answered with a `code`. */
  againLabel?: string;
  icon?: PageButtonIcon;
  style?: PageButtonStyle;
  enabled: boolean;
  action: string;
  /** The answer shows on the button for a moment instead of under it. */
  answerOnButton?: boolean;
  /** Hides this button while adding a card on the reader. */
  hideDuringCapture?: boolean;
  /** Waits for the page to move off this button before reporting a timeout. */
  wait?: PageButtonWait;
  /** Block IDs of form fields (`input`, `select`, `toggle`, `consent`) to validate and include in `payload`. */
  collect?: string[];
  /** Confirmation modal shown before dispatching the action. */
  confirm?: PageButtonConfirm;
  /** Sent back as they are with the action. */
  payload?: Record<string, unknown>;
  /** The block that must be agreed to first; the action then carries `consent: true`. */
  requires?: string;
  needsLocation: boolean;
};

export type PageText = {
  kind: "text";
  id: string;
  text: string;
  /**
   * `status` is a page-level state with nothing else to do (disabled, waiting for the machine,
   * scan to start, nothing here yet): a centred icon, `text` as its title and an optional `detail`.
   * Clients that predate it draw `text` alone as a centred subtitle.
   */
  style?: "heading" | "body" | "caption" | "status";
  level?: "error" | "muted";
  /** With `style: "status"`. */
  icon?: PageStatusIcon;
  /** With `style: "status"`: a second, quieter line. */
  detail?: string;
};

export type PageConsent = {
  kind: "consent";
  id: string;
  text: string;
};

export type PageSection = {
  kind: "section";
  id: string;
  title?: string;
  subtitle?: string;
  style?: "card" | "plain";
  blocks: PageBlock[];
};

export type PageRow = {
  kind: "row";
  id: string;
  blocks: PageBlock[];
};

export type PageKeyValueItem = {
  id?: string;
  label: string;
  value: string;
  tone?: PageTone;
  icon?: PageKeyValueIcon;
  badge?: string;
  badgeTone?: PageTone;
};

export type PageKeyValue = {
  kind: "kv";
  id: string;
  items: PageKeyValueItem[];
};

export type PageBanner = {
  kind: "banner";
  id: string;
  title?: string;
  body: string;
  level?: "info" | "success" | "warning" | "error";
};

export type PageDivider = {
  kind: "divider";
  id: string;
};

export type PageImage = {
  kind: "image";
  id: string;
  url: string;
  alt?: string;
  aspectRatio?: number;
};

export type PageInputField = {
  kind: "input";
  id: string;
  name?: string;
  label?: string;
  placeholder?: string;
  inputType?: "text" | "number";
  defaultValue?: string;
  required?: boolean;
  maxLength?: number;
  helperText?: string;
  enabled?: boolean;
};

export type PageSelectOption = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

export type PageSelectField = {
  kind: "select";
  id: string;
  name?: string;
  label?: string;
  style?: "list" | "segmented";
  options: PageSelectOption[];
  defaultValue?: string;
  required?: boolean;
  enabled?: boolean;
};

export type PageToggleField = {
  kind: "toggle";
  id: string;
  name?: string;
  label: string;
  description?: string;
  defaultValue?: boolean;
  required?: boolean;
  enabled?: boolean;
};

export type PageSignInMethod = {
  id: string;
  provider: "munet" | "passkey";
  label: string;
  busyLabel: string;
  style?: "primary";
  unsupportedText?: string;
};

export type PageSignIn = {
  kind: "signin";
  id: string;
  methods: PageSignInMethod[];
};

export type PageBinding = {
  kind: "binding";
  id: string;
  title: string;
  expiresLabel: string;
  copyLabel: string;
  copiedLabel: string;
  retryLabel: string;
};

export type PagePricingLabels = {
  title: string;
  sharedCapsTitle: string;
  stoppedTitle: string;
  startedTag: string;
  keptTag: string;
  fixedFee: string;
  notBilled: string;
  notCovered: string;
  uncapped: string;
  capReached: string;
  accumulated: string;
  cap: string;
  minuteUnit: string;
  listSeparator: string;
};

export type PagePricing = {
  kind: "pricing";
  id: string;
  rules: unknown;
  changes: unknown;
  labels: PagePricingLabels;
};

export type PageClimateMode = {
  value: string;
  label: string;
  icon?: "cool" | "heat" | "dry" | "fan" | "auto";
};

export type PageClimateFan = {
  value: string;
  label: string;
};

export type PageClimate = {
  kind: "climate";
  id: string;
  state: ClimateState | null;
  needsLocation: boolean;
  title: string;
  unknownStatus: string;
  offLabel: string;
  roomText: string | null;
  currentModeLabel: string | null;
  turnOnLabel: string;
  turnOffLabel: string;
  temperatureLabel: string;
  lowerTemperatureLabel: string;
  raiseTemperatureLabel: string;
  modeLabel: string;
  fanLabel: string;
  modes: PageClimateMode[];
  fanModes: PageClimateFan[];
  actions: {
    on: string;
    off: string;
    setMode: string;
    setTemperature: string;
    setFanMode: string;
  };
};

export type PageCardsAction = {
  id: string;
  label: string;
  action: "cards.capture" | "cards.reload";
  style?: "primary";
};

export type PageCardsCapture = {
  title: string;
  addLabel: string;
  startingText: string;
  waitingText: string;
  cancelLabel: string;
  doneLabel: string;
  leftPageText: string;
  outcomes: {
    added: string;
    taken: string;
    unsupported: string;
    expired: string;
  };
};

export type PageCards = {
  kind: "cards";
  id: string;
  enabled: boolean;
  capture: boolean;
  action: string;
  needsLocation: boolean;
  title: string;
  loadingLabel: string;
  locatingLabel: string;
  swipingLabel: string;
  endingTemplate: string;
  empty: { text: string; actions: PageCardsAction[] };
  loadError: { title: string; actions: PageCardsAction[] };
  captureUi?: PageCardsCapture;
};

export type PageTable = {
  kind: "table";
  id: string;
  title: string;
  status: string;
  capacity: number;
  emptyLabel: string;
  mineLabel: string;
  seats: Array<{ name: string; mine: boolean }>;
};

export type PageBillLabels = {
  totalLabel: string;
  legendLabel: string;
  billingLegend: string;
  cappedLegend: string;
  settledTitle: string;
  balanceAfterLabel: string;
  headings: { current: string; end: string; start: string; switch: string; over: string };
  capFullSuffix: string;
  capUntilLabel: string;
  newDayLabel: string;
  hourUnit: string;
  minuteUnit: string;
  billingUnitLabel: string;
  estimateError: string;
  retryLabel: string;
};

export type PageBill = {
  kind: "bill";
  id: string;
  mode: "live" | "settled";
  timeZone?: string;
  /** Live billing snapshot for client-side worker/engine estimation (avoids Worker CPU load). */
  billingInputs?: { playerId: string; billingSnapshot: unknown };
  /** Precomputed preview (always set for `settled`; fallback for `live` when client billing is unavailable). */
  preview?: unknown;
  settledAt?: string;
  balanceAfter?: number | null;
  labels: PageBillLabels;
};

export type PageTarget = {
  view: string;
  item?: string;
  cursor?: string;
};

export type PageListItem = {
  id: string;
  /** Optional section header label; consecutive items with the same group share a grouped card. */
  group?: string;
  title: string;
  /** Optional muted inline annotation next to title (e.g. stay duration). */
  titleMeta?: string;
  subtitle?: string;
  titleTimestamp?: string;
  subtitleTimestamp?: string;
  subtitlePrefix?: string;
  trailing?: string;
  /** Optional muted strikethrough value beneath trailing (e.g. pre-discount subtotal). */
  trailingStrikethrough?: string;
  open?: PageTarget;
};

export type PageList = {
  kind: "list";
  id: string;
  items: PageListItem[];
  timeZone?: string;
  emptyText?: string;
  emptyIcon?: "receipt" | "inbox";
  moreLabel?: string;
  moreTarget?: PageTarget;
};

export type PageAccountTab = { id: string; label: string };

export type PageAccountMenu = {
  billingBadge?: string;
  tabs: PageAccountTab[];
  logoutLabel: string;
};

export type PageCelebration = {
  title: string;
  subtitle: string;
  effect?: "checkout";
};

export type PageBlock =
  | PageButton
  | PageText
  | PageConsent
  | PageSection
  | PageRow
  | PageKeyValue
  | PageBanner
  | PageDivider
  | PageImage
  | PageInputField
  | PageSelectField
  | PageToggleField
  | PageSignIn
  | PageBinding
  | PagePricing
  | PageClimate
  | PageTable
  | PageBill
  | PageList
  /** Where the player's cards go. The cards themselves are read when the page opens, not with it. */
  | PageCards;
export type Page = {
  shop: string;
  shopCode: string;
  heroUrl: string | null;
  resource: string;
  publicId: string;
  /** The player has something billing at this shop, here or elsewhere. */
  billingActive: boolean;
  /** There is something to use here, so a player who just signed in may be offered a passkey first. */
  offerPasskeySetup: boolean;
  title?: string;
  backLabel?: string;
  accountMenu?: PageAccountMenu;
  clientNotices?: Record<string, PageNotice>;
  blocks: PageBlock[];
  footer?: PageBlock[];
};

/** A door code, shown above the button that asked for it until it expires. It exists only in that action's answer. */
export type PageCode = { title: string; value: string; expiresAt: string; expiresLabel: string; hint: string };
