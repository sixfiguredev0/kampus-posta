import { IBM_Plex_Mono, Onest } from 'next/font/google';
import './globals.css';

// Cyrillic-first geometric sans; downloaded at build time and served from this app (no runtime Google requests).
const onest = Onest({ subsets: ['cyrillic', 'latin'], weight: ['400', '500', '600'], variable: '--font-onest', display: 'swap' });
// Mono for figures only (dates, counts, sizes), like a postmark.
const plexMono = IBM_Plex_Mono({ subsets: ['cyrillic', 'latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata = {
  title: 'Кампус Поща',
  description: 'Поща за студенти на Технически университет – София.',
};

export const viewport = {
  themeColor: '#0b0d14',
  colorScheme: 'dark light',
};

// Applies the saved theme before first paint, so light-theme users do not get a dark flash on load.
const themeScript = "try{var t=localStorage.getItem('campus-theme');if(t==='system')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";

export default function RootLayout({ children }) {
  return <html lang="bg" data-theme="dark" className={onest.variable + ' ' + plexMono.variable} suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
    <body>{children}</body>
  </html>;
}
