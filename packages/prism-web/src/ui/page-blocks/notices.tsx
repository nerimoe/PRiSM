import { AlertCircle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { Notice } from "../../api";

export function NoticeIcon({ level, size }: { level: Notice["level"]; size: number }) {
  const Icon = level === "success" ? CheckCircle2 : level === "error" ? XCircle : level === "info" ? Info : AlertCircle;
  return <Icon size={size} aria-hidden="true" />;
}

export function InlineNoticeLine({ note }: { note: Notice }) {
  return <p className="inline-notice" data-level={note.level} role="status"><NoticeIcon level={note.level} size={18} />{note.body}</p>;
}

export function FeedbackIcon({ level }: { level: Notice["level"] }) {
  const Icon = level === "success" ? CheckCircle2 : level === "error" ? XCircle : AlertCircle;
  return <Icon size={24} className="credential-feedback-icon" aria-hidden="true" />;
}

/** A problem this device found, shown like one the server sent. */
export const localNote = (body: string): Notice =>
  ({ code: "CLIENT", level: "warning", display: "inline", flow: "none", title: null, body, actions: [] });
