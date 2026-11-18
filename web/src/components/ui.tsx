/**
 * The component set. One card, one table, one button family, one badge family,
 * one empty state, one skeleton, one error state — every page composes these
 * rather than styling its own.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "./Icon.js";
import type { Polled } from "../lib/usePolled.js";
import type { ApiError } from "../lib/api.js";
import { ago } from "../lib/format.js";

export type Tone = "neutral" | "ok" | "warn" | "err" | "info" | "accent";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ layout */

export function PageHeader({ title, subtitle, actions }: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <div className="sub">{subtitle}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, subtitle, icon, actions, children, footer, flush, className }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Drop body padding — for tables that should reach the card edges. */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <div className="card-head">
          {icon && <Icon name={icon} size={15} />}
          <h3>{title}</h3>
          {subtitle && <span className="sub">{subtitle}</span>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      <div className={cx("card-body", flush && "flush")}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

/* ----------------------------------------------------------------- buttons */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "danger-solid" | "ghost";
  size?: "md" | "sm";
  icon?: IconName;
  pending?: boolean;
};

export function Button({
  variant = "default", size = "md", icon, pending, children, className, disabled, ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "btn",
        variant !== "default" && `btn-${variant}`,
        size === "sm" && "btn-sm",
        !children && "btn-icon",
        className,
      )}
      disabled={disabled || pending}
      {...rest}
    >
      {pending ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === "sm" ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

/** Nav-style link that looks like a button. */
export function LinkButton({ to, children, icon, variant = "default", size = "md" }: {
  to: string;
  children: ReactNode;
  icon?: IconName;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
}) {
  return (
    <Link
      to={to}
      className={cx("btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm")}
      style={{ textDecoration: "none" }}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 13 : 15} />}
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------- indicators */

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={cx("badge", tone !== "neutral" && `badge-${tone}`)} title={title}>{children}</span>;
}

export function StatusDot({ tone = "neutral", title }: { tone?: Tone; title?: string }) {
  return <span className={cx("dot", tone !== "neutral" && `dot-${tone}`)} title={title} />;
}

export function ProgressBar({ value, tone, width }: { value: number; tone?: "ok" | "warn" | "err"; width?: number }) {
  const pct = Math.max(0, Math.min(1, isFinite(value) ? value : 0)) * 100;
  return (
    <div className={cx("progress", tone)} style={width ? { width } : undefined}
      role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, meta, tone }: { label: string; value: ReactNode; meta?: ReactNode; tone?: Tone }) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className={cx("v", tone === "ok" && "ok-text", tone === "warn" && "warn-text", tone === "err" && "err-text")}>{value}</div>
      {meta != null && <div className="m">{meta}</div>}
    </div>
  );
}

export function Alert({ tone = "neutral", title, children, actions }: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const icon: IconName = tone === "err" ? "alert" : tone === "warn" ? "alert" : tone === "ok" ? "check" : "info";
  return (
    <div className={cx("alert", tone !== "neutral" && `alert-${tone}`)}>
      <Icon name={icon} size={15} />
      <div className="grow break">
        {title && <strong>{title}</strong>}
        {title && children ? <div className="mt-2">{children}</div> : children}
      </div>
      {actions && <div className="row-nowrap">{actions}</div>}
    </div>
  );
}

/* -------------------------------------------------------- loading / empty */

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${100 - (i % 3) * 14}%`, height: i === 0 ? 16 : 12 }} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function EmptyState({ icon = "inbox", title, message, actions }: {
  icon?: IconName;
  title: string;
  message?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="icon"><Icon name={icon} size={19} /></span>
      <h4>{title}</h4>
      {message && <p>{message}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/**
 * The single error surface. It reads the HTTP status so the user gets the
 * actionable version of the failure rather than a raw message:
 *   409 → the service isn't configured (link to Services)
 *   404 → the endpoint isn't available on this server build
 *   502 → the upstream service failed
 */
export function ErrorState({ error, onRetry, what }: { error: ApiError; onRetry?: () => void; what?: string }) {
  const retry = onRetry ? <Button size="sm" icon="refresh" onClick={onRetry}>Retry</Button> : null;

  if (error.status === 409) {
    return (
      <EmptyState
        icon="plug"
        title="Service not configured"
        message={<>{error.message}. Add its base URL and credentials on the Services page, then come back.</>}
        actions={<><LinkButton to="/services" icon="plug" size="sm" variant="primary">Open Services</LinkButton>{retry}</>}
      />
    );
  }
  if (error.status === 404) {
    return (
      <EmptyState
        icon="info"
        title={`${what ?? "This data"} isn't available`}
        message="The server build running here does not expose this endpoint yet."
        actions={retry ?? undefined}
      />
    );
  }
  if (error.status === 0) {
    return (
      <EmptyState
        icon="alert"
        title="Can't reach the TorHQ server"
        message={error.message}
        actions={retry ?? undefined}
      />
    );
  }
  return (
    <EmptyState
      icon="alert"
      title={error.status === 502 ? "Upstream service failed" : `Request failed (${error.status})`}
      message={error.message}
      actions={retry ?? undefined}
    />
  );
}

/**
 * Render-prop wrapper around a polled query: skeleton on first load, the shared
 * error state on a failed first load, and the caller's content otherwise. When
 * a *refresh* fails but data is still on screen, `StaleNotice` surfaces it.
 */
export function Async<T>({ q, what, skeleton, children }: {
  q: Polled<T>;
  what?: string;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (q.data == null && q.error) return <ErrorState error={q.error} onRetry={q.refresh} what={what} />;
  if (q.data == null) return <>{skeleton ?? <Skeleton />}</>;
  return <>{children(q.data)}</>;
}

/** Shown when data is on screen but the latest refresh failed. */
export function StaleNotice({ q }: { q: Polled<unknown> }) {
  if (!q.error || q.data == null) return null;
  return (
    <div className="mt-3">
      <Alert tone="warn" title="Showing cached data" actions={<Button size="sm" icon="refresh" onClick={q.refresh}>Retry</Button>}>
        Last refresh failed: {q.error.message}
        {q.updatedAt ? ` · updated ${ago(q.updatedAt)}` : ""}
      </Alert>
    </div>
  );
}

/** Refresh control with the "as of" timestamp, used in card/page headers. */
export function RefreshButton({ q, label }: { q: Polled<unknown>; label?: string }) {
  return (
    <Button
      size="sm"
      icon="refresh"
      pending={q.loading}
      onClick={() => void q.refresh()}
      title={q.updatedAt ? `Updated ${ago(q.updatedAt)}` : "Never loaded"}
    >
      {label ?? "Refresh"}
    </Button>
  );
}

/* -------------------------------------------------------------------- form */

export function Field({ label, hint, error, children, htmlFor }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
      {error && <div className="field-err">{error}</div>}
    </div>
  );
}

export function TextField(props: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  const { label, hint, className, id, ...rest } = props;
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field label={label} hint={hint} htmlFor={fieldId}>
      <input id={fieldId} className={cx("input", className)} {...rest} />
    </Field>
  );
}

export function SelectField(props: React.SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode; hint?: ReactNode }) {
  const { label, hint, className, id, children, ...rest } = props;
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field label={label} hint={hint} htmlFor={fieldId}>
      <select id={fieldId} className={cx("select", className)} {...rest}>{children}</select>
    </Field>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------------- modal */

export function Modal({ title, onClose, children, footer, labelledBy, wide, className }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // Move focus into the dialog so Escape/Tab work without a mouse.
    const focusable = ref.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]), select, textarea, button",
    );
    focusable?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cx("modal", wide && "modal-wide", className)} role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <div className="modal-head">
          <h3 id={labelledBy}>{title}</h3>
          <div style={{ marginLeft: "auto" }}>
            <Button variant="ghost" size="sm" icon="close" aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Destructive-action confirmation. `requireText` escalates it: the user must
 * type the exact word before the button enables — used for delete-with-files,
 * which is the only action in TorHQ that destroys data on disk.
 */
export function ConfirmDialog({
  title, body, confirmLabel = "Confirm", tone = "danger-solid", requireText,
  pending, error, extra, onConfirm, onClose,
}: {
  title: ReactNode;
  body: ReactNode;
  confirmLabel?: string;
  tone?: ButtonProps["variant"];
  requireText?: string;
  pending?: boolean;
  error?: string | null;
  /** Extra controls rendered above the buttons (e.g. removal options). */
  extra?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const armed = !requireText || typed.trim().toUpperCase() === requireText.toUpperCase();
  const titleId = useId();

  return (
    <Modal
      title={title}
      onClose={onClose}
      labelledBy={titleId}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant={tone} onClick={onConfirm} disabled={!armed} pending={pending}>{confirmLabel}</Button>
        </>
      }
    >
      <div className="stack">
        <div className="break">{body}</div>
        {extra}
        {requireText && (
          <Field label={<>Type <code>{requireText}</code> to confirm</>}>
            <input
              className="input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder={requireText}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
        )}
        {error && <Alert tone="err" title="That didn't work">{error}</Alert>}
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- misc bits */

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap">{children}</div>;
}

/** Inline result line under an action (sent / failed / pending). */
export function InlineStatus({ tone, children }: { tone: "ok" | "err" | "muted"; children: ReactNode }) {
  return <div className={cx("small", tone === "ok" && "ok-text", tone === "err" && "err-text", tone === "muted" && "muted")}>{children}</div>;
}

export { cx };
