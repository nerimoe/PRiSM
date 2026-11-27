import { CheckCircle2, CircleAlert, Info } from "lucide-react";
import type { Notice } from "../../api";

/**
 * A notice has one of two natures. `info` (and `success`, the same nature with
 * a tick) says how things stand or what to do next. `error` says what the
 * player asked for did not happen. Each nature has one icon and one colour,
 * wherever the notice is drawn.
 */
export function NoticeIcon({ level, size, className }: { level: Notice["level"]; size: number; className?: string }) {
  const Icon = level === "success" ? CheckCircle2 : level === "info" ? Info : CircleAlert;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

/**
 * How long an inline notice stays, in ms: news fades by itself; an error stays
 * until the player acts again (`null`), unless it sits where the control's own
 * label has to come back (`onControl`).
 */
export function noticeLasts(level: Notice["level"], onControl = false): number | null {
  if (level === "success") return 3000;
  if (level === "info") return 4000;
  return onControl ? 5000 : null;
}

/** New responses supply timing; legacy responses keep their original lifetime. */
export function noticeDuration(note: Notice, onControl = false): number | null {
  if (onControl && note.controlDurationMs !== undefined) return note.controlDurationMs;
  if (!onControl && note.durationMs !== undefined) return note.durationMs;
  if (!onControl && (note.presentation === "status" || note.presentation === "field")) return null;
  return noticeLasts(note.level, onControl || note.presentation === "toast");
}

/** The one look of a notice shown next to what the player touched: a tinted strip with an icon. */
export function InlineNoticeLine({ note }: { note: Notice }) {
  return (
    <p className="inline-notice" data-level={note.level} role={note.level === "error" ? "alert" : "status"}>
      <NoticeIcon level={note.level} size={18} className="inline-notice-icon" />
      <span>{note.body}</span>
    </p>
  );
}

export function FeedbackIcon({ level }: { level: Notice["level"] }) {
  return <NoticeIcon level={level} size={24} className={`credential-feedback-icon is-${level}`} />;
}

/** A problem this device found (no location, no reply in time), shown like one the server sent. */
export const localNote = (body: string): Notice =>
  ({ code: "CLIENT", level: "error", display: "inline", presentation: "toast", flow: "none", title: null, body, actions: [] });
