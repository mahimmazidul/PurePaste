"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Flame,
  Link2,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { saveLocalItem } from "@/lib/local-items";
import { timeUntil } from "@/lib/time";
import {
  DEFAULT_EXPIRY,
  EXPIRIES,
  LANGUAGES,
  MAX_CONTENT_CHARS,
} from "@/lib/constants";

type Mode = "paste" | "link";

type Done = {
  kind: Mode;
  id: string;
  manageToken: string;
  expiresAt: string;
  burn: boolean;
  title: string | null;
};

/* ——— small field primitives ——— */

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="smallcaps text-ink-3">{label}</span>
      <span className="relative inline-flex">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="cursor-pointer appearance-none rounded-md border border-line bg-sunken py-1.5 pl-2.5 pr-8 text-[0.8125rem] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
          strokeWidth={2}
        />
      </span>
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="mt-[2px] flex size-[17px] shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-raised transition-colors peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--ring)]">
        <Check
          className={`size-3 text-accent-ink transition-opacity ${checked ? "opacity-100" : "opacity-0"}`}
          strokeWidth={3}
        />
      </span>
      <span className="text-sm leading-snug text-ink-2">
        <span className="block text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[0.8125rem] text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

const inputCls =
  "w-full rounded-md border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-ink-3/70 transition-colors hover:border-line-strong focus:border-accent/50";

/* ——— the composer ——— */

export function Composer() {
  const [mode, setMode] = useState<Mode>("paste");

  // paste state
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [language, setLanguage] = useState("plain");
  const [asMarkdown, setAsMarkdown] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // link state
  const [url, setUrl] = useState("");

  // shared state
  const [expiry, setExpiry] = useState<string>(DEFAULT_EXPIRY);
  const [burn, setBurn] = useState(false);
  const [password, setPassword] = useState("");
  const [slug, setSlug] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const chars = content.length;
  const expiryLabel = EXPIRIES.find((e) => e.key === expiry)?.label ?? "";

  // Auto-grow the editor like a sheet of paper.
  const grow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(320, el.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    if (mode === "paste") grow();
  }, [content, mode, grow]);

  function pickLanguage(v: string) {
    setLanguage(v);
    if (v === "markdown") setAsMarkdown(true);
  }

  async function submit() {
    setError(null);
    if (mode === "paste" && !content.trim()) {
      setError("Write something first — empty slips aren't kept.");
      textareaRef.current?.focus();
      return;
    }
    if (mode === "paste" && chars > MAX_CONTENT_CHARS) {
      setError(`Keep it under ${MAX_CONTENT_CHARS.toLocaleString()} characters.`);
      return;
    }
    if (mode === "link" && !url.trim()) {
      setError("Give the link somewhere to go first.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(mode === "paste" ? "/api/pastes" : "/api/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "paste"
            ? {
                title: title || null,
                content,
                language,
                format: asMarkdown ? "markdown" : "code",
                burn,
                password: password || null,
                slug: slug || null,
                expiry,
              }
            : { url, burn, slug: slug || null, expiry },
        ),
      });
      const data = (await res.json()) as {
        id?: string;
        manageToken?: string;
        expiresAt?: string;
        error?: string;
      };
      if (!res.ok || !data.id || !data.manageToken || !data.expiresAt) {
        setError(data.error ?? "Something went sideways — please try again.");
        return;
      }
      const finalTitle = mode === "paste" ? title.trim() || null : url.trim();
      saveLocalItem({
        kind: mode,
        id: data.id,
        title: finalTitle,
        url: `${window.location.origin}/${mode === "paste" ? "p" : "l"}/${data.id}`,
        manageToken: data.manageToken,
        expiresAt: data.expiresAt,
        createdAt: new Date().toISOString(),
      });
      setDone({
        kind: mode,
        id: data.id,
        manageToken: data.manageToken,
        expiresAt: data.expiresAt,
        burn,
        title: finalTitle,
      });
    } catch {
      setError("Couldn't reach the server — is your connection awake?");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setDone(null);
    setTitle("");
    setContent("");
    setUrl("");
    setSlug("");
    setPassword("");
    setBurn(false);
    setError(null);
  }

  function onEditorKey(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !busy) {
      e.preventDefault();
      void submit();
    }
  }

  /* ——— success panel ——— */
  if (done) {
    const path = `/${done.kind === "paste" ? "p" : "l"}/${done.id}`;
    const fullUrl =
      typeof window !== "undefined" ? `${window.location.origin}${path}` : path;
    return (
      <section className="rise-in rounded-xl border border-line bg-raised p-6 shadow-[var(--shadow)] sm:p-8">
        <div className="flex items-start gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
            <Check className="size-5" strokeWidth={2.25} />
          </span>
          <div>
            <h2 className="font-display-it text-[1.75rem] leading-tight tracking-tight text-ink">
              Sealed.
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">
              {done.kind === "paste" ? "Your slip" : "Your link"} lives for now — it
              expires {timeUntil(done.expiresAt)}
              {done.burn ? ", and burns the moment it's opened" : ""}. Nothing lists it;
              the link below is the only way in.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <div className="flex min-w-0 flex-1 items-center rounded-lg border border-line bg-sunken px-3.5 py-2.5">
            <span className="truncate font-mono text-sm text-ink">{fullUrl}</span>
          </div>
          <div className="flex gap-2">
            <CopyButton text={fullUrl} label="Copy link" className="justify-center px-3.5 py-2.5" />
            <a
              href={path}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2.5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong"
            >
              Open
              <ArrowUpRight className="size-4" strokeWidth={2} />
            </a>
          </div>
        </div>

        <p className="mt-4 flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
          <Flame className="size-3.5" strokeWidth={1.75} />
          A delete key was saved in this browser, under “Kept on this device”.
        </p>

        <button
          type="button"
          onClick={reset}
          className="mt-6 text-sm text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-ink-3"
        >
          Make another
        </button>
      </section>
    );
  }

  /* ——— form ——— */
  return (
    <section className="rise-in rise-in-1 overflow-hidden rounded-xl border border-line bg-raised shadow-[var(--shadow)]">
      {/* mode tabs */}
      <div className="flex items-center justify-between px-5 pt-5 sm:px-7">
        <div className="inline-flex rounded-lg border border-line bg-sunken p-[3px]">
          {(
            [
              { key: "paste", label: "A slip", Icon: FileText },
              { key: "link", label: "A link", Icon: Link2 },
            ] as const
          ).map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setMode(key);
                setError(null);
              }}
              className={`inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[0.8125rem] transition-colors ${
                mode === key
                  ? "bg-raised text-ink shadow-sm"
                  : "text-ink-3 hover:text-ink-2"
              }`}
            >
              <Icon className="size-3.5" strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </div>
        <span className="smallcaps hidden text-ink-3 sm:block">
          {mode === "paste" ? "code · notes · prose" : "short, honest links"}
        </span>
      </div>

      {mode === "paste" ? (
        <div className="px-5 pb-2 pt-4 sm:px-7">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="Give it a name, if you like"
            aria-label="Title (optional)"
            className="w-full bg-transparent font-display text-[1.375rem] tracking-tight text-ink placeholder:italic placeholder:text-ink-3/60 focus:outline-none"
          />
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={onEditorKey}
            placeholder="Write or paste — a stack trace, a poem, a letter…"
            aria-label="Paste content"
            spellCheck={false}
            className="code-block mt-3 block min-h-[320px] w-full resize-none bg-transparent text-ink placeholder:text-ink-3/60 focus:outline-none"
            style={{ height: 320 }}
          />
        </div>
      ) : (
        <div className="px-5 pb-2 pt-6 sm:px-7">
          <label className="smallcaps block text-ink-3" htmlFor="dest">
            Destination
          </label>
          <input
            id="dest"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={onEditorKey}
            placeholder="https://somewhere.interesting/…"
            inputMode="url"
            spellCheck={false}
            className="mt-2 w-full bg-transparent font-mono text-[0.9375rem] text-ink placeholder:text-ink-3/60 focus:outline-none"
          />
          <p className="mt-3 pb-4 text-[0.8125rem] leading-relaxed text-ink-3">
            Visitors see the destination first, then choose to continue — nobody lands
            somewhere unexpected.
          </p>
        </div>
      )}

      {/* options */}
      <div className="border-t border-line px-5 py-4 sm:px-7">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-4">
          {mode === "paste" && (
            <SelectField
              label="Language"
              value={language}
              onChange={pickLanguage}
              options={LANGUAGES.map((l) => ({ value: l.id, label: l.label }))}
            />
          )}
          <SelectField
            label="Lives for"
            value={expiry}
            onChange={setExpiry}
            options={EXPIRIES.map((e) => ({ value: e.key, label: e.label }))}
          />
          <div className="pb-0.5">
            <Toggle
              checked={burn}
              onChange={setBurn}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Flame className="size-3.5 text-ink-3" strokeWidth={1.75} />
                  Burn after reading
                </span>
              }
            />
          </div>
          {mode === "paste" && (
            <div className="pb-0.5">
              <Toggle checked={asMarkdown} onChange={setAsMarkdown} label="Render Markdown" />
            </div>
          )}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            className="mb-0.5 inline-flex items-center gap-1.5 text-sm text-ink-3 transition-colors hover:text-ink"
          >
            <Plus
              className={`size-3.5 transition-transform duration-200 ${moreOpen ? "rotate-45" : ""}`}
              strokeWidth={2}
            />
            {moreOpen ? "Fewer options" : "More options"}
          </button>
        </div>

        {moreOpen && (
          <div className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <label className="block">
              <span className="smallcaps text-ink-3">Custom name · optional</span>
              <span className="mt-1.5 flex items-center gap-1.5">
                <span className="font-mono text-sm text-ink-3">
                  /{mode === "paste" ? "p" : "l"}/
                </span>
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  placeholder="my-note"
                  spellCheck={false}
                  className={`${inputCls} font-mono`}
                />
              </span>
            </label>
            {mode === "paste" && (
              <label className="block">
                <span className="smallcaps text-ink-3">Password · optional</span>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  placeholder="A word you'll share by voice"
                  autoComplete="new-password"
                  className={`${inputCls} mt-1.5`}
                />
              </label>
            )}
          </div>
        )}
      </div>

      {/* footer / submit */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line bg-sunken/50 px-5 py-3.5 sm:px-7">
        <span className="text-[0.8125rem] text-ink-3">
          {mode === "paste" ? (
            <>
              {chars.toLocaleString()} characters · lives for {expiryLabel}
            </>
          ) : (
            <>Lives for {expiryLabel}</>
          )}
        </span>
        <div className="flex items-center gap-4">
          <span className="hidden items-center gap-1 text-[0.75rem] text-ink-3/80 sm:flex">
            <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-sans text-[0.6875rem]">⌘</kbd>
            <span>+</span>
            <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-sans text-[0.6875rem]">Enter</kbd>
            <span className="ml-0.5">to seal</span>
          </span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink shadow-sm transition-all hover:bg-accent-strong disabled:cursor-wait disabled:opacity-70"
          >
            {busy && <LoaderCircle className="size-4 animate-spin" strokeWidth={2.25} />}
            {busy ? "Sealing…" : mode === "paste" ? "Seal this slip" : "Seal this link"}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-t border-line bg-danger-soft px-5 py-3 text-sm text-danger sm:px-7">
          <CircleAlert className="size-4 shrink-0" strokeWidth={1.75} />
          {error}
        </div>
      )}
    </section>
  );
}
