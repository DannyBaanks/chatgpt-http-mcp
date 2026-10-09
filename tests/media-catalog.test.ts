import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCatalog } from '../src/media/catalog';
test('media registration rejects changed, revoked and redirected assets', async () => {
 const root=mkdtempSync(join(tmpdir(),'isymcp-media-test-')); const c=new MediaCatalog(join(root,'state'));
 const file=join(root,'test.wav'); writeFileSync(file,'original');
 const a=await c.add(file); expect((await c.resolve(a.id)).sha256).toBe(a.sha256);
 writeFileSync(file,'changed'); await expect(c.resolve(a.id)).rejects.toThrow('changed');
 const b=await c.add(file); c.revoke(b.id); await expect(c.resolve(b.id)).rejects.toThrow('revoked');
 await expect(c.resolve('../outside')).rejects.toThrow('Invalid asset');
 const link=join(root,'link.wav'); symlinkSync(file,link); const l=await c.add(link);
 const other=join(root,'other.wav'); writeFileSync(other,'changed'); unlinkSync(link); symlinkSync(other,link);
 await expect(c.resolve(l.id)).rejects.toThrow('changed');
});
