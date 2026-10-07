import type { ReactNode } from 'react';

const shapes = {
  bolt: <path d="m13.5 2-9 12h6l-1 8 10-13h-7l1-7Z" />,
  'arrow-right': <><path d="M4 12h15m-6-6 6 6-6 6" /></>,
  'arrow-left': <path d="M20 12H5m6-6-6 6 6 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  sparkles: <><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z" /><path d="M20 2v4m-2-2h4" /></>,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  plus: <path d="M12 4v16M4 12h16" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 13 2l1 4M4 12l1 4a8 8 0 0 0 13 2" /></>,
  expand: <><path d="M14 3h7v7M10 21H3v-7M21 3l-7 7M3 21l7-7" /></>,
  shield: <><path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5l8-3Z" /><path d="m8 11 3 3 5-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  desktop: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
  mobile: <><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M10 5h4m-3 14h2" /></>,
  alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.5" /></>,
  key: <><circle cx="8" cy="9" r="5" /><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3" /></>,
} satisfies Record<string, ReactNode>;

export function Icon({ name, className = '' }: { name: keyof typeof shapes; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {shapes[name]}
  </svg>;
}
