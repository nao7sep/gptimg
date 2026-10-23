// Every image in the open chat, newest first, beside the conversation: the
// ones the assistant made and the ones the user attached. Clicking one explicitly
// selects it for the next message; clicking again removes that attachment.
// Recent images are resent automatically when the provider conversation expires.
// The assistant has no tool for looking up other images in this pane.
import { imageUrl, type OpenedSession } from "../../../shared/api.ts";
import { useI18n } from "../i18n.tsx";
import { CheckIcon } from "./icons.tsx";

export interface PaneImage {
  /** Session-relative path: what an attachment sends. */
  path: string;
  absolute: string;
  /** The user attached it, rather than the assistant making it. */
  attached: boolean;
}

export function paneImages(session: OpenedSession): PaneImage[] {
  const sep = session.dir.includes("\\") ? "\\" : "/";
  const seen = new Set<string>();
  const out: PaneImage[] = [];
  for (const turn of [...session.doc.turns].reverse()) {
    for (const path of [...turn.images].reverse()) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, absolute: `${session.dir}${sep}${path.split("/").join(sep)}`, attached: turn.role === "user" });
    }
  }
  return out;
}

export function ImagesPane({ images, chosen, onToggle }: { images: PaneImage[]; chosen: ReadonlySet<string>; onToggle: (image: PaneImage) => void }) {
  const { t } = useI18n();
  return (
    <aside className="images-pane" aria-label={t("images.label")}>
      <header className="images-head">
        <h2>{t("images.title")}</h2>
        <span className="images-count">{images.length}</span>
      </header>
      {images.length === 0 ? (
        <p className="images-empty">{t("images.empty")}</p>
      ) : (
        <>
          <p className="images-hint">{t("images.hint")}</p>
          <ul className="images-grid">
            {images.map((image) => {
              const on = chosen.has(image.path);
              return (
                <li key={image.path}>
                  <button
                    type="button"
                    className={`images-thumb${on ? " on" : ""}`}
                    aria-pressed={on}
                    aria-label={t(image.attached ? "images.yours" : "images.made")}
                    title={t(on ? "images.detach" : "images.attach")}
                    onClick={() => onToggle(image)}
                  >
                    <img src={imageUrl(image.absolute, 240)} alt="" draggable={false} loading="lazy" />
                    {on && (
                      <span className="images-check" aria-hidden="true">
                        <CheckIcon size={13} />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}
