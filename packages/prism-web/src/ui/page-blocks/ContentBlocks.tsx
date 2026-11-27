import { BadgeCheck, Coins, Gift, Sparkles, Tag, TicketPercent, Wallet } from "lucide-react";
import {
  resolvePageImageUrl, type PageBanner, type PageImage, type PageKeyValue, type PageKeyValueIcon, type PageRow,
  type PageSection, type PageTable, type PageText,
} from "@prism/page-protocol";
import { BlockList } from "./BlockView";
import { NoticeIcon } from "./notices";
import { StatusView } from "./StatusView";

const KV_ICONS: Record<PageKeyValueIcon, typeof Wallet> = {
  wallet: Wallet,
  gift: Gift,
  coins: Coins,
  coupon: TicketPercent,
  pass: BadgeCheck,
  ticket: Tag,
  asset: Sparkles,
};

export function TextBlock({ block }: { block: PageText }) {
  if (block.style === "status") {
    return <StatusView icon={block.icon} title={block.text} detail={block.detail} tone={block.level} />;
  }
  if (block.style === "heading") {
    const tint = block.level === "error" ? "text-coral" : block.level === "muted" ? "opacity-60" : undefined;
    return <h2 className={tint ? `page-text-heading ${tint}` : "page-text-heading"}>{block.text}</h2>;
  }
  if (block.level === "error") {
    const size = block.style === "caption" ? "text-xs" : block.style === "body" ? "text-base" : "text-sm";
    return <p role="alert" className={`${size} text-coral`}>{block.text}</p>;
  }
  if (block.style === "body") return <p className={`page-text-body${block.level === "muted" ? " is-muted" : ""}`}>{block.text}</p>;
  if (block.style === "caption") return <p className="page-text-caption">{block.text}</p>;
  return <p className={`session-subtitle text-center${block.level === "muted" ? " opacity-60" : ""}`}>{block.text}</p>;
}

export function SectionBlock({ block, depth }: { block: PageSection; depth: number }) {
  return (
    <section className={`page-section${block.style === "card" ? " is-card" : ""}`}>
      {(block.title || block.subtitle) && (
        <header className="page-section-head">
          {block.title && <h2>{block.title}</h2>}
          {block.subtitle && <p>{block.subtitle}</p>}
        </header>
      )}
      <div className="page-section-body">
        <BlockList blocks={block.blocks} depth={depth + 1} />
      </div>
    </section>
  );
}

export function RowBlock({ block, depth }: { block: PageRow; depth: number }) {
  return <div className="page-row"><BlockList blocks={block.blocks} depth={depth + 1} /></div>;
}

export function KeyValueBlock({ block }: { block: PageKeyValue }) {
  return (
    <dl className="page-kv">
      {block.items.map((item, index) => {
        const Icon = item.icon ? KV_ICONS[item.icon] : null;
        const badgeTone = item.badgeTone ?? item.tone ?? "default";
        if (Icon || item.badge) {
          return (
            <div key={item.id ?? `${index}-${item.label}`} className="page-kv-row is-rich">
              {Icon && (
                <span className="page-kv-icon" data-tone={badgeTone} aria-hidden="true">
                  <Icon size={18} />
                </span>
              )}
              <dt className="page-kv-copy">
                <span className="page-kv-label">{item.label}</span>
                {item.badge && <span className="page-kv-badge" data-tone={badgeTone}>{item.badge}</span>}
              </dt>
              <dd data-tone={item.tone ?? "default"}>{item.value}</dd>
            </div>
          );
        }
        return (
          <div key={item.id ?? `${index}-${item.label}`} className="page-kv-row">
            <dt>{item.label}</dt>
            <dd data-tone={item.tone ?? "default"}>{item.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function BannerBlock({ block }: { block: PageBanner }) {
  const level = block.level ?? "info";
  return (
    <div className="page-banner" data-level={level} role={level === "error" || level === "warning" ? "alert" : "status"}>
      <NoticeIcon level={level === "warning" ? "error" : level} size={20} />
      <div className="page-banner-copy">
        {block.title && <strong>{block.title}</strong>}
        <p>{block.body}</p>
      </div>
    </div>
  );
}

export function ImageBlock({ block }: { block: PageImage }) {
  const src = resolvePageImageUrl(block.url, window.location.origin);
  if (!src) return null;
  return (
    <figure className="page-image">
      <img
        src={src}
        alt={block.alt ?? ""}
        style={block.aspectRatio && block.aspectRatio > 0 ? { aspectRatio: String(block.aspectRatio) } : undefined}
        loading="lazy"
      />
    </figure>
  );
}

export function TableBlock({ block }: { block: PageTable }) {
  return (
    <section className="table-card">
      <header className="table-heading">
        <div><h2>{block.title}</h2><p>{block.status}</p></div>
        <span className="table-count">{block.seats.length}<span> / {block.capacity}</span></span>
      </header>
      <ul className="table-seats">
        {Array.from({ length: block.capacity }, (_, index) => {
          const seat = block.seats[index];
          return (
            <li className={`table-seat${seat?.mine ? " is-mine" : ""}${!seat ? " is-empty" : ""}`} key={index}>
              <span className="table-seat-name">{seat?.name || block.emptyLabel}</span>
              {seat?.mine && <span className="table-self">{block.mineLabel}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
