export type BusinessItemStatus = "active" | "archived";

export type BusinessItem = {
  id: string;
  kind: string;
  name: string;
  status: BusinessItemStatus;
  price: number;
  assetType: string | null;
  assetCode: string | null;
  activeAt: Date | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BusinessItemOrderStatus = "paid" | "fulfilled" | "cancelled";

export type BusinessItemOrder = {
  id: string;
  businessItemId: string;
  businessItemKind: string;
  businessItemName: string;
  playerId: string;
  sessionId: string;
  status: BusinessItemOrderStatus;
  price: number;
  assetType: string | null;
  assetCode: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  fulfilledAt: Date | null;
  cancelledAt: Date | null;
};
