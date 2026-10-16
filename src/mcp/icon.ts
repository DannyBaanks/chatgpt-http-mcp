import { readFileSync } from 'node:fs';

export function serverIcon(): { src: string; mimeType: string; sizes: string[] } {
  const data = readFileSync(new URL('../../assets/isymcp-icon.png', import.meta.url)).toString('base64');
  return { src: `data:image/png;base64,${data}`, mimeType: 'image/png', sizes: ['256x256'] };
}
