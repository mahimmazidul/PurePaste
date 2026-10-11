"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  className = "",
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onClick = useCallback(async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [text]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[0.8125rem] text-ink-2 transition-colors hover:border-line-strong hover:text-ink ${className}`}
    >
      {copied ? (
        <Check className="size-3.5 text-accent" strokeWidth={2} />
      ) : (
        <Copy className="size-3.5" strokeWidth={1.75} />
      )}
      {copied ? copiedLabel : label}
    </button>
  );
}
