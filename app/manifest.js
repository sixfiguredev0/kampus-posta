export default function manifest() {
  return {
    name: 'Кампус Поща',
    short_name: 'Поща',
    description: 'Поща за студенти на Технически университет – София.',
    start_url: '/mail',
    display: 'standalone',
    background_color: '#050814',
    theme_color: '#050814',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
