// Image attachments for the agent chat (CONTRACTS.md §5.6): the composer's pending-upload state,
// its thumbnail strip, the thumbnails in a sent turn and a lightbox for the full image.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";
import type { AttachmentInfo, AttachmentMeta } from "@/lib/contracts";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  MAX_ATTACHMENTS,
  attachmentUrl,
  uploadAttachment,
} from "@/lib/daemon";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface PendingAttachment {
  key: string;
  name: string;
  size: number;
  /** Local object URL, so the thumbnail shows before the upload finishes. */
  previewUrl: string;
  status: "uploading" | "done" | "error";
  /** 0–1 */
  progress: number;
  error?: string;
  info?: AttachmentInfo;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

let keySeq = 0;

/** Clipboard images arrive as "image.png"; give them a readable, distinct name. */
function displayName(file: File): string {
  const pasted = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!pasted) return file.name;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `Pasted image ${hh}.${mm}.${ss}.${EXT[file.type] ?? "png"}`;
}

export function isImageFile(file: File): boolean {
  return (ATTACHMENT_TYPES as readonly string[]).includes(file.type);
}

/**
 * Uploaded, unsent images per project while another project is open: attachments are uploaded
 * into one project (§5.6), so the composer keeps each project's own and brings them back when
 * that project is opened again (never sending one project's image with another's prompt).
 */
const parkedAttachments = new Map<string, PendingAttachment[]>();

/**
 * Pending images of one composer: validation, upload with progress, removal. With `parkKey`
 * (the project id) the finished ones are parked on unmount and restored by the next composer
 * mounted with the same key; uploads still running are cancelled.
 */
export function useComposerAttachments(parkKey?: string) {
  const [initial] = useState<PendingAttachment[]>(() => {
    if (parkKey === undefined) return [];
    const parked = parkedAttachments.get(parkKey) ?? [];
    parkedAttachments.delete(parkKey);
    return parked;
  });
  const [items, setItems] = useState<PendingAttachment[]>(initial);
  const itemsRef = useRef<PendingAttachment[]>(initial);
  const aborts = useRef(new Map<string, () => void>());

  const update = useCallback((fn: (list: PendingAttachment[]) => PendingAttachment[]) => {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }, []);

  const patch = useCallback(
    (key: string, p: Partial<PendingAttachment>) =>
      update((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i))),
    [update],
  );

  /** Adds images; returns a short notice for what was skipped, or null. */
  const add = useCallback(
    (files: File[]): string | null => {
      const notices: string[] = [];
      const accepted: { item: PendingAttachment; file: File }[] = [];
      let room = MAX_ATTACHMENTS - itemsRef.current.length;
      for (const file of files) {
        if (!isImageFile(file)) {
          notices.push(`${file.name || "That file"} isn't a PNG, JPEG, GIF or WebP image`);
          continue;
        }
        if (room <= 0) {
          notices.push(`Up to ${MAX_ATTACHMENTS} images per message`);
          break;
        }
        room -= 1;
        const tooBig = file.size > ATTACHMENT_MAX_BYTES;
        accepted.push({
          file,
          item: {
            key: `att-${++keySeq}`,
            name: displayName(file),
            size: file.size,
            previewUrl: URL.createObjectURL(file),
            status: tooBig ? "error" : "uploading",
            progress: 0,
            ...(tooBig ? { error: "Larger than 10 MB" } : {}),
          },
        });
      }
      if (accepted.length) update((list) => [...list, ...accepted.map((a) => a.item)]);
      for (const { item, file } of accepted) {
        if (item.status !== "uploading") continue;
        const handle = uploadAttachment(file, item.name, (progress) => patch(item.key, { progress }));
        aborts.current.set(item.key, handle.abort);
        handle.done
          .then((info) => patch(item.key, { status: "done", progress: 1, info }))
          .catch((err: Error) => patch(item.key, { status: "error", error: err.message }))
          .finally(() => aborts.current.delete(item.key));
      }
      return notices[0] ?? null;
    },
    [patch, update],
  );

  const remove = useCallback(
    (key: string) => {
      aborts.current.get(key)?.();
      const gone = itemsRef.current.find((i) => i.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      update((list) => list.filter((i) => i.key !== key));
    },
    [update],
  );

  const clear = useCallback(() => {
    for (const abort of aborts.current.values()) abort();
    for (const i of itemsRef.current) URL.revokeObjectURL(i.previewUrl);
    update(() => []);
  }, [update]);

  useEffect(() => {
    // Parked items live in this composer's state now (a stale copy must not come back later).
    if (parkKey !== undefined) parkedAttachments.delete(parkKey);
    return () => {
      for (const abort of aborts.current.values()) abort();
      const keep = parkKey !== undefined ? itemsRef.current.filter((i) => i.status === "done") : [];
      for (const i of itemsRef.current) if (!keep.includes(i)) URL.revokeObjectURL(i.previewUrl);
      if (parkKey !== undefined && keep.length > 0) parkedAttachments.set(parkKey, keep);
    };
  }, [parkKey]);

  return { items, add, remove, clear };
}

/** The composer's thumbnails row. */
export function AttachmentStrip({
  items,
  onRemove,
  onOpen,
}: {
  items: PendingAttachment[];
  onRemove: (key: string) => void;
  onOpen: (index: number) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2.5" aria-label="Attached images">
      {items.map((item, i) => {
        const failed = item.status === "error";
        const uploading = item.status === "uploading";
        const dims = item.info?.width && item.info.height ? ` · ${item.info.width}×${item.info.height}` : "";
        return (
          <div key={item.key} className="group/att relative">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpen(i)}
                  aria-label={`Preview ${item.name}`}
                  className={cn(
                    "relative block size-14 overflow-hidden rounded-xl bg-surface-2 ring-1 transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    failed ? "ring-bad/70" : "ring-hairline hover:ring-primary/50",
                  )}
                >
                  <img
                    src={item.previewUrl}
                    alt=""
                    draggable={false}
                    className={cn("size-full object-cover", (uploading || failed) && "opacity-55")}
                  />
                  {failed ? (
                    <span className="absolute inset-0 grid place-items-center bg-bad/15">
                      <AlertCircle className="size-4 text-bad" />
                    </span>
                  ) : (
                    <span className="absolute inset-x-1 bottom-1 truncate rounded-[5px] bg-black/55 px-1 text-center font-mono text-[9.5px] leading-[14px] text-white/90">
                      {formatBytes(item.size)}
                    </span>
                  )}
                  {uploading ? (
                    <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30">
                      <span
                        className="block h-full bg-primary transition-[width] duration-150"
                        style={{ width: `${Math.max(6, Math.round(item.progress * 100))}%` }}
                      />
                    </span>
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-64">
                <p className="truncate text-foreground">{item.name}</p>
                <p className={cn("font-mono text-caption", failed ? "text-bad" : "text-muted-foreground")}>
                  {failed
                    ? (item.error ?? "Upload failed")
                    : uploading
                      ? `Uploading… ${Math.round(item.progress * 100)}%`
                      : `${formatBytes(item.size)}${dims}`}
                </p>
              </TooltipContent>
            </Tooltip>
            <button
              type="button"
              aria-label={`Remove ${item.name}`}
              onClick={() => onRemove(item.key)}
              className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background opacity-0 shadow-card transition-opacity group-hover/att:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3" strokeWidth={2.5} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export interface LightboxImage {
  src: string;
  name: string;
  detail?: string;
}

/** Full-size view of one image of a set; ←/→ step through, Esc closes. */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
}: {
  images: LightboxImage[];
  index: number | null;
  onIndexChange: (index: number | null) => void;
}) {
  const open = index !== null && index >= 0 && index < images.length;
  const current = open ? images[index] : undefined;
  const many = images.length > 1;
  const step = (d: number) => {
    if (index === null) return;
    onIndexChange((index + d + images.length) % images.length);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onIndexChange(null)}>
      <DialogContent
        className="w-auto max-w-[min(94vw,1400px)] gap-2 border-hairline bg-popover p-2.5 sm:rounded-2xl"
        onKeyDown={(e) => {
          if (!many) return;
          if (e.key === "ArrowRight") step(1);
          else if (e.key === "ArrowLeft") step(-1);
        }}
      >
        <DialogTitle className="sr-only">{current?.name ?? "Image"}</DialogTitle>
        <DialogDescription className="sr-only">
          Attached image{many ? ` ${index! + 1} of ${images.length}` : ""}. Press Escape to close.
        </DialogDescription>
        {current ? (
          <div className="flex h-6 min-w-0 items-center gap-2 ps-1.5 pe-9 text-label">
            <span className="min-w-0 truncate text-foreground/90">{current.name}</span>
            {current.detail ? (
              <span className="shrink-0 font-mono text-caption text-faint">{current.detail}</span>
            ) : null}
            {many ? (
              <span className="ms-auto shrink-0 font-mono text-caption text-faint">
                {index! + 1} / {images.length}
              </span>
            ) : null}
          </div>
        ) : null}
        {current ? (
          <div className="relative grid place-items-center">
            <img
              src={current.src}
              alt={current.name}
              className="max-h-[80vh] max-w-full rounded-xl bg-[repeating-conic-gradient(var(--surface-2)_0%_25%,var(--surface-1)_0%_50%)] bg-[length:16px_16px] object-contain"
            />
            {many ? (
              <>
                <button
                  type="button"
                  aria-label="Previous image"
                  onClick={() => step(-1)}
                  className="absolute top-1/2 left-2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Next image"
                  onClick={() => step(1)}
                  className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
                >
                  <ChevronRight className="size-4" />
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TurnThumb({ a, onOpen }: { a: AttachmentMeta; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  const src = attachmentUrl(a.id);
  if (broken || !src) {
    return (
      <span
        title={`${a.name} — no longer available`}
        className="grid size-20 place-items-center rounded-xl bg-surface-2 text-faint ring-1 ring-hairline"
      >
        <ImageOff className="size-4" />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={a.name}
      aria-label={`Open ${a.name}`}
      className="block h-20 max-w-40 min-w-12 overflow-hidden rounded-xl bg-surface-2 ring-1 ring-hairline transition-shadow outline-none hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={src}
        alt={a.name}
        loading="lazy"
        draggable={false}
        onError={() => setBroken(true)}
        className="h-full w-auto max-w-40 min-w-12 object-cover"
      />
    </button>
  );
}

/** The images of a sent prompt, above the user's bubble. */
export function TurnAttachments({ attachments }: { attachments: AttachmentMeta[] | undefined }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!attachments?.length) return null;
  const images: LightboxImage[] = attachments.flatMap((a) => {
    const src = attachmentUrl(a.id);
    return src ? [{ src, name: a.name }] : [];
  });
  return (
    <>
      <div className="flex max-w-[88%] flex-wrap justify-end gap-1.5">
        {attachments.map((a, i) => (
          <TurnThumb key={`${a.id}-${i}`} a={a} onOpen={() => setOpen(i)} />
        ))}
      </div>
      <ImageLightbox images={images} index={open} onIndexChange={setOpen} />
    </>
  );
}
