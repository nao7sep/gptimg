// GptImg's own drawn icons: one 20-unit grid, 1.6 strokes, round joins.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Svg>
);

export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="2.6" />
    <path d="M10 2.8v2M10 15.2v2M17.2 10h-2M4.8 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3 4.9 4.9" />
  </Svg>
);

export const ClipIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 9.2 9.4 14.3a3.1 3.1 0 0 1-4.4-4.4l5.6-5.6a2.1 2.1 0 0 1 3 3L8 12.9a1 1 0 0 1-1.5-1.5l4.9-4.9" />
  </Svg>
);

export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />
  </Svg>
);

export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.6" fill="currentColor" stroke="none" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
  </Svg>
);

/** An empty print: the rail's cover for a session with no image yet. */
export const FrameIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="14" height="12" rx="1.8" />
    <path d="m3.5 13.5 3.8-3.6 2.8 2.6 2.2-1.9 4.2 3.4" />
    <circle cx="13" cy="7.6" r="1.2" />
  </Svg>
);

export const ExpandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.5 4h4.5v4.5M8.5 16H4v-4.5M16 4l-5 5M4 16l5-5" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="9" height="9" rx="1.6" />
    <path d="M13 7V5.6A1.6 1.6 0 0 0 11.4 4H5.6A1.6 1.6 0 0 0 4 5.6v5.8A1.6 1.6 0 0 0 5.6 13H7" />
  </Svg>
);

export const ExportIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4 14.5v1A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-1" />
  </Svg>
);

/** Use as reference: the print goes back down into the composer. */
export const ReuseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4v5.5A2.5 2.5 0 0 0 7.5 12H15M11.5 8.5 15 12l-3.5 3.5" />
  </Svg>
);

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h3l1.6 1.8h6A1.7 1.7 0 0 1 17 8v6.3a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3Z" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.6A1.5 1.5 0 0 0 7.8 17h4.4a1.5 1.5 0 0 0 1.5-1.4l.8-9.6" />
  </Svg>
);

export const RetryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15.5 10a5.5 5.5 0 1 1-1.7-4M15.8 3.8v3.4h-3.4" />
  </Svg>
);

export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12.6 4.4 3 3L7.4 15.6l-3.6.6.6-3.6Z" />
  </Svg>
);

export const EyeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5Z" />
    <circle cx="10" cy="10" r="2.2" />
  </Svg>
);

/** The composer's shape glyphs: the frame each size will produce. */
export function ShapeGlyph({ shape, ...p }: IconProps & { shape: string }) {
  const frames: Record<string, { w: number; h: number }> = {
    "1024x1024": { w: 11, h: 11 },
    "1024x1536": { w: 9, h: 13 },
    "1536x1024": { w: 14, h: 9.4 },
  };
  const frame = frames[shape];
  if (!frame) {
    return (
      <Svg {...p}>
        <rect x="4" y="4" width="12" height="12" rx="1.6" strokeDasharray="2.2 2" />
        <path d="M8 12.3 10 7.7l2 4.6M8.7 10.8h2.6" strokeWidth={1.3} />
      </Svg>
    );
  }
  return (
    <Svg {...p}>
      <rect x={10 - frame.w / 2} y={10 - frame.h / 2} width={frame.w} height={frame.h} rx="1.4" />
    </Svg>
  );
}
