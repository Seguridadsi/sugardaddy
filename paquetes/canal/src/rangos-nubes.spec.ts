import { describe, expect, it } from 'vitest';
import { motivoNoCompartible, nubeDeIp } from './index.ts';
import { RANGOS_NUBES } from './rangos-nubes-datos.ts';

describe('lo que nunca entra en la lista común', () => {
	it('trae las fuentes de las nubes y CDN grandes', () => {
		const ids = RANGOS_NUBES.map((p) => p.id);
		for (const id of ['aws', 'azure', 'google-cloud', 'cloudflare', 'fastly', 'microsoft-365'])
			expect(ids).toContain(id);
	});

	it('cada red de la lista es una red válida', () => {
		for (const p of RANGOS_NUBES)
			for (const r of p.rangos.split(' ')) expect(r).toMatch(/^[0-9a-f.:]+(\/\d{1,3})?$/);
	});

	it.each([
		['104.16.0.1', 'cloudflare'],
		['2606:4700::1111', 'cloudflare-v6'],
		['151.101.1.1', 'fastly']
	])('%s es de %s', (ip, id) => expect(nubeDeIp(ip)?.id).toBe(id));

	it('la primera y la última dirección de cada red de un proveedor caen dentro', () => {
		const p = RANGOS_NUBES.find((x) => x.id === 'cloudflare')!;
		expect(nubeDeIp('173.245.48.0')).not.toBeNull();
		expect(nubeDeIp('173.245.63.255')).not.toBeNull();
		expect(p.rangos).toContain('173.245.48.0/20');
	});

	it('una IP de un atacante cualquiera sí puede entrar', () => {
		expect(nubeDeIp('185.220.101.34')).toBeNull();
		expect(motivoNoCompartible('185.220.101.34')).toBeNull();
	});

	it.each(['100.64.1.1', '100.127.255.254', '10.0.0.1', '192.0.2.1'])(
		'%s (CGNAT, privada o reservada) no entra',
		(ip) => expect(motivoNoCompartible(ip)).toMatch(/not a public address/)
	);

	it.each(['185.220.101.0/24', '0.0.0.0/0', 'no-es-ip', ''])(
		'%s no es una IP suelta: no entra',
		(v) => expect(motivoNoCompartible(v)).toBe('not a single IP address')
	);

	it.each(['1.1.1.1', '9.9.9.9', '2620:fe::fe', '2620:00fe::00fe'])(
		'%s es un DNS público: no entra',
		(ip) => expect(motivoNoCompartible(ip)).toBe('public DNS resolver')
	);

	it('una IP de una nube dice de cuál', () => {
		expect(motivoNoCompartible('104.16.0.1')).toBe('shared address of Cloudflare');
	});
});
