import { beforeEach, describe, expect, it, vi } from 'vitest';

const entorno: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env: entorno }));

const { rechazoEdl } = await import('./edl-acceso');

const TOKEN = 'a'.repeat(64);
const pedir = (authorization?: string) =>
	new Request('https://nodo/api/edl/negra', {
		headers: authorization ? { authorization } : {}
	});
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

describe('acceso a la EDL', () => {
	beforeEach(() => {
		entorno.EDL_TOKEN = TOKEN;
	});

	it('sin token en el nodo contesta 503', () => {
		entorno.EDL_TOKEN = '';
		expect(() => rechazoEdl(pedir(`Bearer ${TOKEN}`))).toThrow();
	});

	it('vale Bearer y Basic con cualquier usuario', () => {
		expect(rechazoEdl(pedir(`Bearer ${TOKEN}`))).toBeNull();
		expect(rechazoEdl(pedir(basic('sugardaddy', TOKEN)))).toBeNull();
		expect(rechazoEdl(pedir(basic('palo-alto', TOKEN)))).toBeNull();
	});

	it('rechaza lo demás con 401 y pide Basic', () => {
		for (const a of [undefined, `Bearer ${TOKEN}x`, basic('x', 'malo'), 'Basic !!!', TOKEN]) {
			const r = rechazoEdl(pedir(a));
			expect(r?.status).toBe(401);
			expect(r?.headers.get('www-authenticate')).toMatch(/^Basic/);
		}
	});
});
