import type {
  AssetHoldingUnavailableReason,
  Cents,
  BillTimeline,
  DeviceCommand,
  DeviceCommandType,
  DeviceState,
  MachineConnection,
  RedeemCode,
} from "@prism/core";

export type PlayerSummary = {
  player: {
    id: string;
    displayName: string;
    status: "active" | "disabled" | "banned";
  };
  wallet: Array<{
    assetCode: string;
    quantity: Cents;
  }>;
  activeSession: {
    id: string;
    startedAt: Date;
  } | null;
};

export type PlayerAssetHoldingListItem = {
  id: string;
  assetType: string;
  assetCode: string;
  assetName: string | null;
  quantity: number;
  activeAt: Date | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
  availability?: "available" | "unavailable";
  unavailableReasons?: AssetHoldingUnavailableReason[];
};

export type PlayerAssetLedgerListItem = {
  id: string;
  assetType: string;
  assetCode: string;
  assetName: string;
  delta: number;
  reason: string;
  refId: string;
  transactionId: string | null;
  createdAt: Date;
};

export type PlayerAssets = {
  holdings: PlayerAssetHoldingListItem[];
  ledgerEntries: PlayerAssetLedgerListItem[];
};

export type SessionHistoryListItem = {
  sessionId: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMinutes: number | null;
  subtotal: Cents | null;
  total: Cents | null;
  status: "active" | "closed" | "settled";
  settledAt: Date | null;
};

export type SessionHistoryDetail = SessionHistoryListItem & {
  chargeItems: Array<{
    id: string;
    source: string;
    label: string;
    amount: Cents;
  }>;
  adjustments: Array<{
    id: string;
    source: string;
    label: string;
    amount: Cents;
  }>;
};

export type StaffRedeemCodeRedemptionListItem = {
  codeId: string;
  playerId: string;
  playerDisplayName: string;
  redeemedAt: Date;
};

export type PlayerRedeemRecordListItem = {
  codeId: string;
  code: string;
  presentId: string;
  presentName: string;
  redeemedAt: Date;
};

export type CheckoutHistoryRecord = {
  id: string;
  subtotal?: number;
  total: number;
  settledAt: string;
  startedAt: string | null;
  endedAt: string | null;
  sessionCount: number;
  paymentMethod?: string | null;
};
export type PlayerCheckoutReceipt = {
  externalPayment?: { method: string; staffId: string; collectedAt: string };
  settlements?: Array<{ settlement: { sessionId: string; startedAt: string; endedAt: string | null } }>;
  playerSettlement: { total: number; settledAt: string };
  timeline: BillTimeline;
  wallet?: { balanceAfter: number } | null;
  chargeItems: { id: string; label: string; amount: number }[];
  adjustments: { id: string; label: string; amount: number }[];
};
export type PlayerQueries = {
  listPlayerCheckouts?(playerId: string, offset: number): Promise<{ records: CheckoutHistoryRecord[]; nextOffset: number | null }>;
  getPlayerCheckout?(playerId: string, checkoutId: string): Promise<PlayerCheckoutReceipt | null>;
  getLatestPlayerCheckout?(playerId: string): Promise<PlayerCheckoutReceipt | null>;
  getPlayerSummary(playerId: string): Promise<PlayerSummary>;
  listPlayerAssets?(playerId: string): Promise<PlayerAssets>;
  listPlayerSessionHistory?(playerId: string): Promise<SessionHistoryListItem[]>;
  getPlayerSessionHistoryDetail?(playerId: string, sessionId: string): Promise<SessionHistoryDetail | null>;
};

export type StaffPlayerListItem = {
  paymentMode?: "cashier";
  id: string;
  displayName: string;
  status: "active" | "disabled" | "banned";
  walletTotal: Cents;
  activeSessionId: string | null;
  hasUnpaidSession?: boolean;
  identities?: Array<{
    provider: string;
    subject: string;
    displayName?: string;
    createdAt: Date;
  }>;
};

export type StaffActiveSessionListItem = {
  id: string;
  playerId: string;
  playerDisplayName: string;
  startedAt: Date;
  endedAt?: Date | null;
  elapsedMinutes: number;
  label?: string | null;
  /** The plan the session bills; null for the unpriced placeholder session. */
  pricingConfigId?: string | null;
  status?: "active" | "closed";
  identities?: Array<{
    provider: string;
    subject: string;
  }>;
};

export type StaffDeviceCommandListItem = {
  id: string;
  type: DeviceCommandType;
  deviceId: string | null;
  targetKind: DeviceCommand["targetKind"];
  executorKind: DeviceCommand["executorKind"];
  playerId: string | null;
  staffId: string | null;
  status: DeviceCommand["status"];
  requestedAt: Date;
  ackedAt: Date | null;
  expiredAt: Date | null;
  payload: Record<string, unknown> | null;
};

export type StaffReportsSummaryInput = {
  from: Date;
  to: Date;
};

export type StaffReportsSummary = StaffReportsSummaryInput & {
  revenueTotal: Cents;
  sessionCount: number;
  assetGrantTotal: number;
  coinCommandCount: number;
};

export type StaffReportsAnalyticsInput = {
  excludedPlayerIds?: readonly string[];
  days?: number;
  startDate?: string;
  endDate?: string;
  timeZone: string;
};

/** Batch facts for browser-side historical reporting. Monetary totals are integer cents. */
export type StaffReportsAnalyticsSource = {
  excludedPlayerIds?: string[];
  range: { days: number; timeZone: string; from: string; to: string; startDate: string; endDate: string };
  asOf: string;
  checkoutRows: { id: string; player_id: string; total: number; settled_at: string; duration_minutes: number; payment_method: string | null }[];
  sessionRows: { player_id: string; started_at: string; ended_at: string | null; checkout_id?: string | null }[];
  playerRows: { created_at: string }[];
  operationRows: { device_id: string | null; player_id?: string | null; action: string; status: string; counts_as_play: number; requested_at: string }[];
  assetGrantCount: number;
  /** Shop setting: every stay is effective up to this many hours after it starts (default 12). */
  stayCapHours?: number;
};

export type StaffReportsAnalyticsDailyPoint = {
  date: string;
  revenue: Cents;
  checkouts: number;
  visits: number;
  coins: number;
};

export type StaffReportsAnalyticsPaymentMethod = {
  method: "balance" | "wechat" | "alipay" | "cash" | "other";
  revenue: Cents;
  count: number;
};

export type StaffReportsAnalyticsDeviceActivity = {
  deviceId: string;
  operations: number;
  coins: number;
  swipes: number;
  visits: number;
  /** Deduplicated plays (see `rankReportDevices` in core): the heat ranking's value. */
  plays: number;
  /** Distinct identified players on the device. */
  players: number;
};

export type StaffReportsAnalytics = {
  range: {
    days: number;
    timeZone: string;
    from: Date;
    to: Date;
    startDate: string;
    endDate: string;
  };
  today: {
    revenueTotal: Cents;
    yesterdayRevenueTotal: Cents;
    checkoutCount: number;
    yesterdayCheckoutCount: number;
    visitCount: number;
    yesterdayVisitCount: number;
    newPlayerCount: number;
    coinCount: number;
    avgDurationMinutes: number;
    medianDurationMinutes: number;
  };
  period: {
    revenueTotal: Cents;
    previousRevenueTotal: Cents;
    checkoutCount: number;
    previousCheckoutCount: number;
    visitCount: number;
    uniquePlayerCount: number;
    newPlayerCount: number;
    avgTicket: Cents;
    medianTicket: Cents;
    avgDurationMinutes: number;
    medianDurationMinutes: number;
    totalEffectiveDurationMinutes: number;
    totalInactiveDurationMinutes: number;
    inactiveCheckoutCount: number;
    coinCount: number;
    assetGrantCount: number;
  };
  daily: StaffReportsAnalyticsDailyPoint[];
  hourlyVisits: number[];
  paymentMethods: StaffReportsAnalyticsPaymentMethod[];
  topDevices: StaffReportsAnalyticsDeviceActivity[];
  topDevicesByHeat: StaffReportsAnalyticsDeviceActivity[];
};

export type StaffReportSettlementListItem = {
  externalPayment?: { method: string; staffId: string };
  settlementId: string;
  sessionId: string;
  playerId: string;
  playerDisplayName: string;
  startedAt: Date;
  endedAt: Date | null;
  settledAt: Date;
  durationMinutes: number | null;
  subtotal: Cents;
  total: Cents;
};

export type ReportArchiveFilter = "active" | "archived" | "all";
export type StaffReportCheckout = {
  checkoutId: string;
  playerId: string;
  playerDisplayName: string;
  startedAt: string | null;
  endedAt: string | null;
  settledAt: string;
  durationMinutes: number;
  sessionCount: number;
  subtotal: number;
  total: number;
  archived: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  externalPayment?: { method: string; staffId: string; collectedAt: string };
};
export type StaffReportCheckoutDetail = {
  record: StaffReportCheckout;
  receipt: PlayerCheckoutReceipt;
};

export type StaffReportPlayerListItem = {
  playerId: string;
  playerDisplayName: string;
  settlementCount: number;
  totalDurationMinutes: number;
  revenueTotal: Cents;
  lastSettledAt: Date;
};

export type StaffQueries = {
  listPlayers(input?: { playerIds?: readonly string[] }): Promise<StaffPlayerListItem[]>;
  listActiveSessions(): Promise<StaffActiveSessionListItem[]>;
  listLiveSessions?(input?: { playerIds?: readonly string[] }): Promise<StaffActiveSessionListItem[]>;
  getPlayerAssets?(playerId: string): Promise<PlayerAssets>;
  getPlayerSessionHistory?(playerId: string): Promise<SessionHistoryListItem[]>;
  getPlayerSessionHistoryDetail?(playerId: string, sessionId: string): Promise<SessionHistoryDetail | null>;
  listPlayerRedeemRecords?(playerId: string): Promise<PlayerRedeemRecordListItem[]>;
  listDeviceCommands?(input: { limit: number }): Promise<StaffDeviceCommandListItem[]>;
  listDeviceStates?(): Promise<DeviceState[]>;
  listMachineConnections?(): Promise<MachineConnection[]>;
  getReportsSummary?(input: StaffReportsSummaryInput): Promise<StaffReportsSummary>;
  getReportsAnalyticsSource?(input: StaffReportsAnalyticsInput): Promise<StaffReportsAnalyticsSource>;
  getReportsAnalytics?(input: StaffReportsAnalyticsInput): Promise<StaffReportsAnalytics>;
  /** Checkouts settled in a range, or every checkout of one player when `playerId` is given. */
  listReportCheckouts?(input: (StaffReportsSummaryInput | { playerId: string }) & { limit: number; offset?: number; archive?: ReportArchiveFilter; excludedPlayerIds?: readonly string[] }): Promise<StaffReportCheckout[]>;
  getReportCheckout?(checkoutId: string): Promise<StaffReportCheckoutDetail | null>;
  listReportSettlements?(input: StaffReportsSummaryInput & { limit: number; offset?: number }): Promise<StaffReportSettlementListItem[]>;
  listReportPlayers?(input: StaffReportsSummaryInput & { limit: number; offset?: number }): Promise<StaffReportPlayerListItem[]>;
};

export type StaffRedeemCodeUsageFilter = "unused" | "partial" | "exhausted" | "revoked";
export type StaffRedeemCodeValidityFilter = "valid" | "pending" | "expired";

export type StaffRedeemCodePageInput = {
  limit: number;
  offset?: number;
  presentId?: string;
  usage?: StaffRedeemCodeUsageFilter;
  validity?: StaffRedeemCodeValidityFilter;
  search?: string;
  now?: Date;
};

export type StaffRedeemCodePageResult = {
  codes: RedeemCode[];
  redemptions: StaffRedeemCodeRedemptionListItem[];
  total: number;
  hasMore: boolean;
};

export type StaffRedeemQueries = {
  listRedeemCodeRedemptions?(): Promise<StaffRedeemCodeRedemptionListItem[]>;
  listRedeemCodesPage?(input: StaffRedeemCodePageInput): Promise<StaffRedeemCodePageResult>;
};

export type ApplicationQueries = {
  playerQueries: PlayerQueries;
  staffQueries: StaffQueries;
  staffRedeemQueries?: StaffRedeemQueries;
};
