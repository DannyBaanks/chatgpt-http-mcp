import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCatalog } from '../src/media/catalog';
test('catalog exposes only a media filename on Windows, not its local path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-media-name-')),catalog=new MediaCatalog(join(root,'state'));
 const file=join(root,'sample.mp4');writeFileSync(file,'video bytes');
 const asset=await catalog.add(file);
 expect(asset.name).toBe('sample.mp4');
 const storedPath=join(root,'state',`${asset.id}.json`);
 const legacy=JSON.parse(readFileSync(storedPath,'utf8'));
 writeFileSync(storedPath,JSON.stringify({...legacy,name:file}));
 expect(catalog.list().find(x=>x.id===asset.id)?.name).toBe('sample.mp4');
});
test('media registration rejects changed, revoked and redirected assets', async () => {
 const root=mkdtempSync(join(tmpdir(),'isymcp-media-test-')); const c=new MediaCatalog(join(root,'state'));
 const file=join(root,'test.wav'); writeFileSync(file,'original');
 const a=await c.add(file); expect((await c.resolve(a.id)).sha256).toBe(a.sha256);
 writeFileSync(file,'changed'); await expect(c.resolve(a.id)).rejects.toThrow('changed');
 const b=await c.add(file); c.revoke(b.id); await expect(c.resolve(b.id)).rejects.toThrow('revoked');
 await expect(c.resolve('../outside')).rejects.toThrow('Invalid asset');
 // "Redirected" cambia la IDENTIDAD real del asset sin cambiar bytes ni tamano: en
 // Unix es un symlink de archivo; en Windows ese symlink exige Modo desarrollador,
 // asi que se sustituye por una junction cuyo destino se reemplaza. La afirmacion es
 // la misma: sha idéntico y aun asi debe rechazarse.
 if (process.platform === 'win32') {
  const outside=join(root,'outside'), inside=join(root,'linkdir'), elsewhere=join(root,'elsewhere');
  mkdirSync(outside); mkdirSync(elsewhere);
  writeFileSync(join(outside,'test.wav'),'changed'); writeFileSync(join(elsewhere,'test.wav'),'changed');
  symlinkSync(outside, inside, 'junction');
  const l=await c.add(join(inside,'test.wav'));
  rmdirSync(inside); symlinkSync(elsewhere, inside, 'junction');
  await expect(c.resolve(l.id)).rejects.toThrow('changed');
 } else {
  const link=join(root,'link.wav'); symlinkSync(file,link); const l=await c.add(link);
  const other=join(root,'other.wav'); writeFileSync(other,'changed'); unlinkSync(link); symlinkSync(other,link);
  await expect(c.resolve(l.id)).rejects.toThrow('changed');
 }
});
test('catalog accepts a TikTok receipt only when the final TikTok video identity is verified',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-media-tiktok-receipt-')),catalog=new MediaCatalog(join(root,'state'));
 const file=join(root,'tiktok.mp4');writeFileSync(file,'video bytes');
 const source='https://vt.tiktok.com/ZSgLUAEhe/';
 const canonical='https://www.tiktok.com/@theunearthlyhub/video/7695118893425102113';
 const receipt={platform:'tiktok',video_id:'7695118893425102113',source_url:source,canonical_url:canonical};
 const asset=await catalog.add(file,source,receipt as any);
 expect(catalog.get(asset.id).downloadReceipt).toEqual(receipt);
 await expect(catalog.add(file,source,{...receipt,canonical_url:'https://www.tiktok.com/@other/video/7695118893425102120'} as any)).rejects.toThrow('Invalid media download receipt');
});
