import type { ReactNode } from "react";
import {
  Ban, CircleAlert, Clock, Hourglass, IdCard, Inbox, Nfc, ReceiptText, SlidersHorizontal, Wallet, type LucideIcon,
} from "lucide-react";
import type { PageStatusIcon } from "@prism/page-protocol";

const STATUS_ICONS: Record<PageStatusIcon, LucideIcon> = {
  blocked: Ban,
  waiting: Hourglass,
  scan: Nfc,
  empty: Inbox,
  unavailable: CircleAlert,
  receipt: ReceiptText,
  wallet: Wallet,
  identity: IdCard,
  options: SlidersHorizontal,
};

/** Icons only the client's own states use (no page to come from the server). */
const LOCAL_ICONS = { expired: Clock, failed: CircleAlert } as const;

/**
 * A page-level state with nothing else to do on it: icon, title, an optional quieter line and
 * optional actions. The same shape as the App Clip's `ContentUnavailableView`.
 */
export function StatusView({
  icon,
  title,
  detail,
  tone,
  heading = false,
  children,
}: {
  icon?: PageStatusIcon | keyof typeof LOCAL_ICONS;
  title: string;
  detail?: string;
  tone?: "error" | "muted";
  /** The page's own title (a whole-screen state), rather than a block within a page. */
  heading?: boolean;
  children?: ReactNode;
}) {
  const Icon = icon ? (icon in LOCAL_ICONS ? LOCAL_ICONS[icon as keyof typeof LOCAL_ICONS] : STATUS_ICONS[icon as PageStatusIcon]) : null;
  const Title = heading ? "h1" : "h2";
  return (
    <div className="page-status" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      {Icon && <Icon className="page-status-icon" size={44} strokeWidth={1.6} aria-hidden="true" />}
      <Title className="page-status-title">{title}</Title>
      {detail && <p className="page-status-detail">{detail}</p>}
      {children}
    </div>
  );
}
