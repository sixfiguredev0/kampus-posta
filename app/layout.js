import { Onest } from 'next/font/google';
import './globals.css';

// Cyrillic-first geometric sans; downloaded at build time and served from this app (no runtime Google requests).
const onest = Onest({ subsets: ['cyrillic', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-onest', display: 'swap' });

export const metadata = {
  title: 'Кампус Поща',
  description: 'Поща за студенти на Технически университет – София.',
};

export const viewport = {
  themeColor: '#050814',
  colorScheme: 'dark light',
};

// Applies the saved theme before first paint, so light-theme users do not get a dark flash on load.
const themeScript = "try{var t=localStorage.getItem('campus-theme');if(t==='system')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";

export default function RootLayout({ children }) {
  return <html lang="bg" data-theme="dark" className={onest.variable} suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
    <body>{children}</body>
  </html>;
}
