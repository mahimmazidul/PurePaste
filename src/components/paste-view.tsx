"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import hljs from "highlight.js/lib/common";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlignLeft,
  Download,
  Eye,
  FileCode2,
  Flame,
  Lock,
  Trash2,
} from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { languageLabel } from "@/lib/constants";
import { getManageToken, removeLocalItem } from "@/lib/local-items";
import { formatBytes, timeAgo, timeUntil } from "@/lib/time";
import type { PastePayload } from "@/lib/types";

function highlight(content: string, language: string): string {
  try {
    if (hljs.getLanguage(language)) {
      return hljs.highlight(content, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlight(content, { language: "plaintext" }).value;
  } catch {
    const span = document.createElement("span");
    span.textContent = content;
    return span.innerHTML;
  }
}

const toolBtn =
  "inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[0.8125rem] text-ink-2 transition-colors hover:border-line-strong hover:text-ink";

/** Highlights fenced code blocks inside rendered Markdown. */
const mdComponents: Components = {
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const text = String((children as ReactNode) ?? "").replace(/\n$/, "");
    if (match && hljs.getLanguage(match[1])) {
      return (
        <code
          className={`hljs ${className}`}
          dangerouslySetInnerHTML={{
            __html: hljs.highlight(text, { language: match[1], ignoreIllegals: true }).value,
          }}
        />
      );
    }
    return <code className={className}>{children}</code>;
  },
};

export function PasteView({
  paste,
  destroyed = false,
  revealed = false,
}: {
  paste: PastePayload;
  /** Shown right after a burn-after-reading reveal. */
  destroyed?: boolean;
  /** Reached via a password/burn gate rather than the open web. */
  revealed?: boolean;
}) {
  const [wrap, setWrap] = useState(false);
  const [manageToken, setManageToken] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    setManageToken(getManageToken("paste", paste.id));
  }, [paste.id]);

  const html = useMemo(() => {
    if (paste.format === "markdown") return null;
    return highlight(paste.content, paste.language);
  }, [paste.content, paste.language, paste.format]);

  const lineCount = useMemo(() => paste.content.split("\n").length, [paste.content]);

  const ext = paste.format === "markdown" ? "md" : "txt";

  function download() {
    const blob = new Blob([paste.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${paste.id}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doDelete() {
    if (!manageToken) return;
    try {
      const res = await fetch(`/api/pastes/${paste.id}`, {
        method: "DELETE",
        headers: { "x-manage-token": manageToken },
      });
      if (res.ok) {
        removeLocalItem("paste", paste.id);
        setDeleted(true);
      }
    } catch {
      /* leave the slip be */
    }
  }

  if (deleted) {
    return (
      <div className="rise-in mx-auto max-w-md py-24 text-center">
        <Trash2 className="mx-auto mb-5 size-5 text-ink-3" strokeWidth={1.5} />
        <h1 className="font-display-it text-3xl tracking-tight text-ink">
          Let go, gently.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          The slip is gone from the drawer — not archived, not recoverable. The link
          now leads nowhere.
        </p>
        <a
          href="/"
          className="mt-7 inline-block text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          Back to the desk
        </a>
      </div>
    );
  }

  return (
    <div className="rise-in">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[1.75rem] leading-tight tracking-tight text-ink sm:text-[2rem]">
            {paste.title ?? <span className="italic text-ink-3">Untitled slip</span>}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-ink-3">
            <span className="inline-flex items-center gap-1 text-ink-2">
              <FileCode2 className="size-3.5" strokeWidth={1.75} />
              {paste.format === "markdown" ? "Markdown" : languageLabel(paste.language)}
            </span>
            <span aria-hidden>·</span>
            <span>sealed {timeAgo(paste.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>fades {timeUntil(paste.expiresAt)}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Eye className="size-3.5" strokeWidth={1.75} />
              {paste.views === 1 ? "1 read" : `${paste.views} reads`}
            </span>
            <span aria-hidden>·</span>
            <span>{formatBytes(paste.sizeBytes)}</span>
            {paste.burn && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 text-amber">
                  <Flame className="size-3.5" strokeWidth={1.75} />
                  burns after reading
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={paste.content} label="Copy" />
          {paste.format !== "markdown" && (
            <button
              type="button"
              onClick={() => setWrap((v) => !v)}
              aria-pressed={wrap}
              className={`${toolBtn} ${wrap ? "border-accent/40 bg-accent-soft text-accent" : ""}`}
              title={wrap ? "Don't wrap long lines" : "Wrap long lines"}
            >
              <AlignLeft className="size-3.5" strokeWidth={1.75} />
              Wrap
            </button>
          )}
          <button type="button" onClick={download} className={toolBtn} title={`Download .${ext}`}>
            <Download className="size-3.5" strokeWidth={1.75} />
            Save
          </button>
          {!revealed && (
            <a href={`/p/${paste.id}/raw`} className={toolBtn} title="Plain text, no dressing">
              Raw
            </a>
          )}
          {manageToken && !confirmDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className={`${toolBtn} hover:text-danger`}
              title="You sealed this on this device — you can let it go"
            >
              <Trash2 className="size-3.5" strokeWidth={1.75} />
              Let go
            </button>
          )}
          {manageToken && confirmDelete && (
            <span className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void doDelete()}
                className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-[0.8125rem] text-danger transition-colors hover:bg-danger hover:text-raised"
              >
                Sure?
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className={toolBtn}
              >
                Keep it
              </button>
            </span>
          )}
        </div>
      </div>

      {/* post-burn note */}
      {destroyed && (
        <p className="mt-6 flex items-center gap-2 rounded-lg border border-amber/25 bg-amber-soft px-4 py-3 text-sm text-amber">
          <Flame className="size-4 shrink-0" strokeWidth={1.75} />
          Read once, gone forever — this slip was destroyed the moment it reached you.
        </p>
      )}

      {/* body */}
      {paste.format === "markdown" ? (
        <article className="mt-6 rounded-lg border border-line bg-raised px-6 py-6 shadow-[var(--shadow)] sm:px-8">
          <div className="md-view">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {paste.content}
            </ReactMarkdown>
          </div>
        </article>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-line bg-raised shadow-[var(--shadow)]">
          <div className="overflow-x-auto">
            <div className={wrap ? "" : "flex min-w-full"}>
              {!wrap && lineCount > 1 && (
                <div
                  aria-hidden
                  className="code-block sticky left-0 select-none border-r border-line bg-sunken/60 px-3 py-4 text-right text-ink-3/70"
                >
                  {Array.from({ length: lineCount }, (_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
              )}
              <pre
                className={`code-block flex-1 px-4 py-4 text-ink ${
                  wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : ""
                }`}
              >
                <code
                  className="hljs"
                  dangerouslySetInnerHTML={{ __html: html ?? "" }}
                />
              </pre>
            </div>
          </div>
        </div>
      )}

      <p className="mt-5 flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
        <Lock className="size-3.5" strokeWidth={1.75} />
        Unlisted and unindexed — whoever holds this link holds the slip.
      </p>
    </div>
  );
}
