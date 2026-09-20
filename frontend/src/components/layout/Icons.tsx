/**
 * Inline icon set.
 *
 * Hand-drawn rather than pulled from an icon package: the app uses about a
 * dozen glyphs, and a dependency would ship thousands into a bundle that
 * handles sessions. All are 20×20 on a 1.6 stroke so they sit together evenly.
 */
export type IconProps = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 20 20',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const GaugeIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M3.2 14.5a8 8 0 1 1 13.6 0" />
    <path d="M10 10.8l3.2-3.4" />
    <circle cx="10" cy="11" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const ListIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M7 5.5h9M7 10h9M7 14.5h9" />
    <circle cx="4" cy="5.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="4" cy="10" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="4" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const ChipIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.6" />
    <path d="M8 3v2.5M12 3v2.5M8 14.5V17M12 14.5V17M3 8h2.5M3 12h2.5M14.5 8H17M14.5 12H17" />
  </svg>
);

export const CubeIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M10 2.8l6.2 3.4v7.6L10 17.2 3.8 13.8V6.2z" />
    <path d="M3.8 6.2L10 9.6l6.2-3.4M10 9.6v7.6" />
  </svg>
);

export const MapPinIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M10 17.5s5.2-4.6 5.2-9a5.2 5.2 0 1 0-10.4 0c0 4.4 5.2 9 5.2 9z" />
    <circle cx="10" cy="8.4" r="1.9" />
  </svg>
);

export const ClockIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="10" cy="10" r="7.4" />
    <path d="M10 5.8V10l2.8 1.8" />
  </svg>
);

export const BatteryIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="2.6" y="6.6" width="12.4" height="6.8" rx="1.8" />
    <path d="M17.4 9v2" />
  </svg>
);

export const ThermometerIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M8.2 11.4V4.8a1.8 1.8 0 1 1 3.6 0v6.6a3.6 3.6 0 1 1-3.6 0z" />
  </svg>
);

export const SearchIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="8.8" cy="8.8" r="5.2" />
    <path d="M12.6 12.6L16.6 16.6" />
  </svg>
);

export const DownloadIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M10 3.4v8.4M6.6 8.6L10 12l3.4-3.4M4 15.2h12" />
  </svg>
);

export const PlusIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M10 4.6v10.8M4.6 10h10.8" />
  </svg>
);

export const ShareIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="15" cy="5" r="2.2" />
    <circle cx="5" cy="10" r="2.2" />
    <circle cx="15" cy="15" r="2.2" />
    <path d="M7 8.9l6-2.8M7 11.1l6 2.8" />
  </svg>
);

export const RefreshIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M16.2 8.4A6.4 6.4 0 0 0 4.6 6.6M3.8 11.6a6.4 6.4 0 0 0 11.6 1.8" />
    <path d="M16.6 4.2v4.2h-4.2M3.4 15.8v-4.2h4.2" />
  </svg>
);

export const MenuIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M3.4 6h13.2M3.4 10h13.2M3.4 14h13.2" />
  </svg>
);

export const ChevronRightIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M8 5l5 5-5 5" />
  </svg>
);

export const ChevronLeftIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5l-5 5 5 5" />
  </svg>
);

export const InboxIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M3 11.4l2.2-6a1.6 1.6 0 0 1 1.5-1h6.6a1.6 1.6 0 0 1 1.5 1l2.2 6" />
    <path d="M3 11.4h3.6l1 2h4.8l1-2H17v3.4a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 14.8z" />
  </svg>
);

export const MountainIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M2 15.5l4.6-7.4 3.1 4.6" />
    <path d="M7.6 15.5l4.3-8.2 6.1 8.2z" />
  </svg>
);

export const LayersIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M10 2.8l7 3.6-7 3.6-7-3.6z" />
    <path d="M3 10.4l7 3.6 7-3.6" />
    <path d="M3 13.9l7 3.6 7-3.6" />
  </svg>
);
