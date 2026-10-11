/** Serializable payload handed to client components / API responses. */
export type PastePayload = {
  id: string;
  title: string | null;
  content: string;
  language: string;
  format: "code" | "markdown";
  burn: boolean;
  views: number;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
};

export type PasteMetaPayload = Omit<PastePayload, "content"> & {
  protected: boolean;
};

export type LinkPayload = {
  id: string;
  url: string;
  burn: boolean;
  visits: number;
  createdAt: string;
  expiresAt: string;
};

export type LinkMetaPayload = Omit<LinkPayload, "url">;

/** One record of something created on this device (localStorage). */
export type LocalItem = {
  kind: "paste" | "link";
  id: string;
  title: string | null;
  url: string;
  manageToken: string;
  expiresAt: string;
  createdAt: string;
};
