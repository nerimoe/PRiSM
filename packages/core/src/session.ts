import { PrismDomainError } from "./errors";

export type SessionPaymentStatus = "unpaid" | "paid";

export type Session = {
  id: string;
  playerId: string;
  startedAt: Date;
  endedAt?: Date;
  status?: "active" | "closed";
  pricingConfigIds?: string[];
  paymentStatus?: SessionPaymentStatus;
  label?: string;
  metadata?: Record<string, unknown>;
};

export type StartSessionInput = {
  playerId: string;
  now: Date;
  id: string;
  pricingConfigIds: string[];
  label?: string;
  metadata?: Record<string, unknown>;
};

export type CloseSessionInput = {
  session: Session;
  now: Date;
};

export function startSession(input: StartSessionInput): Session & { status: "active" } {
  if (!input.pricingConfigIds || input.pricingConfigIds.length === 0) {
    throw new PrismDomainError("Session must be started with at least one pricing plan.", "PRICING_CONFIG_REQUIRED");
  }

  return {
    id: input.id,
    playerId: input.playerId,
    startedAt: input.now,
    status: "active",
    pricingConfigIds: input.pricingConfigIds,
    paymentStatus: "unpaid",
    label: input.label,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function closeSession(input: CloseSessionInput): Session & { status: "closed"; endedAt: Date } {
  if (input.session.status !== "active") {
    throw new PrismDomainError("Session is not active.", "SESSION_NOT_ACTIVE");
  }

  return {
    ...input.session,
    endedAt: input.now,
    status: "closed",
  };
}
